import { openUrl } from "@tauri-apps/plugin-opener";
import * as ipc from "@/lib/ipc";
import type { CloseReason, SessionMessage, ShellSpec, TerminalProfile } from "@/lib/ipc";
import { THEMES } from "@/lib/theme";
import { useNotifications } from "@/stores/notifications";
import { useSessions, type SessionProtocol } from "@/stores/sessions";
import { customPalettes, profileById, useTerminalPrefs } from "@/stores/terminalPrefs";
import { encodeBinary, encodeInput } from "./encoding";
import { compilePatterns, trackPrivilege } from "./privilege";
import type { Palette } from "./palette";
import { defaultPaletteFor, findPalette } from "./palettes";
import {
  allTerminals,
  applyOptions,
  createTerminal,
  disposeTerminal,
  getTerminal,
  type TerminalHandle,
} from "./registry";

/**
 * Glue between session tabs, backend sessions and xterm instances. Backend session ids
 * are tracked per tab here; the sessions store only holds what the UI renders.
 */
const backendIds = new Map<string, string>();
const profiles = new Map<string, string>();
const untrack = new Map<string, () => void>();

let compiled: { source: readonly string[]; patterns: RegExp[] } | null = null;
function privilegePatterns(): RegExp[] {
  const source = useTerminalPrefs.getState().prefs.privilegedPromptPatterns;
  if (compiled?.source !== source) compiled = { source, patterns: compilePatterns(source) };
  return compiled.patterns;
}

export function appScheme(): "dark" | "light" {
  const id = document.documentElement.dataset.theme;
  return THEMES.find((t) => t.id === id)?.scheme ?? "dark";
}

export function paletteFor(profile: TerminalProfile): Palette {
  const prefs = useTerminalPrefs.getState().prefs;
  return (
    (profile.paletteId ? findPalette(profile.paletteId, customPalettes(prefs)) : undefined) ??
    defaultPaletteFor(appScheme())
  );
}

function newTabId(): string {
  return `t-${crypto.randomUUID()}`;
}

/** Dim status line written into the terminal view only (never into logs/recordings). */
function statusLine(handle: TerminalHandle, text: string) {
  handle.term.write(`\r\n\x1b[2m[${text}]\x1b[0m\r\n`);
}

function describeClose(reason: CloseReason): string {
  switch (reason.kind) {
    case "exited":
      return reason.code === null ? "Process exited" : `Process exited with code ${reason.code}`;
    case "closed":
      return "Session closed";
    case "error":
      return reason.message;
  }
}

function onMessage(tabId: string, msg: SessionMessage) {
  if (msg.type !== "closed") return;
  backendIds.delete(tabId);
  const handle = getTerminal(tabId);
  const tab = useSessions.getState().tabs.find((t) => t.id === tabId);
  const reason = msg.reason;
  if (tab?.protocol === "local" && reason.kind === "exited" && reason.code === 0) {
    // `exit` in a local shell closes the tab, like other terminals.
    closeTab(tabId);
    return;
  }
  useSessions.getState().setState(tabId, reason.kind === "error" ? "error" : "disconnected");
  if (handle) statusLine(handle, describeClose(reason));
}

function wireInput(tabId: string, handle: TerminalHandle) {
  const send = (bytes: Uint8Array) => {
    const id = backendIds.get(tabId);
    if (!id) return;
    ipc.sessionWrite(id, bytes).catch(() => {
      // The session may have just closed; the close message updates the tab.
    });
  };
  handle.term.onData((d) => send(encodeInput(d)));
  handle.term.onBinary((d) => send(encodeBinary(d)));
  handle.term.onResize(({ cols, rows }) => {
    const id = backendIds.get(tabId);
    if (id) ipc.sessionResize(id, cols, rows).catch(() => {});
  });
}

function openLink(url: string) {
  openUrl(url).catch((e: unknown) =>
    useNotifications.getState().notifyError(e, "Could not open the link"),
  );
}

interface OpenOptions {
  title: string;
  protocol: SessionProtocol;
  profileId?: string | null;
  /** Starts the backend session; receives the initial size and callbacks. */
  start: (cols: number, rows: number, cb: ipc.SessionCallbacks) => Promise<string>;
}

export async function openTerminalTab(opts: OpenOptions): Promise<string> {
  const prefs = useTerminalPrefs.getState().prefs;
  const profile = profileById(prefs, opts.profileId);
  const tabId = newTabId();
  const handle = createTerminal(tabId, profile, paletteFor(profile), openLink);
  profiles.set(tabId, profile.id);
  wireInput(tabId, handle);
  untrack.set(tabId, trackPrivilege(tabId, handle.term, privilegePatterns));
  useSessions
    .getState()
    .open({ id: tabId, title: opts.title, protocol: opts.protocol, state: "connecting" });
  try {
    const id = await opts.start(handle.term.cols, handle.term.rows, {
      // xterm parses on its own schedule; writes are queued in order.
      onData: (bytes) => handle.term.write(bytes),
      onMessage: (msg) => onMessage(tabId, msg),
    });
    backendIds.set(tabId, id);
    // The pane may have been fitted while the session was starting.
    ipc.sessionResize(id, handle.term.cols, handle.term.rows).catch(() => {});
    useSessions.getState().setState(tabId, "connected");
  } catch (e) {
    useSessions.getState().setState(tabId, "error");
    statusLine(handle, ipc.CommandError.from(e).message);
    useNotifications.getState().notifyError(e, `Could not open ${opts.title}`);
  }
  return tabId;
}

export function openLocalShell(spec: ShellSpec | null = null, title = "Local shell") {
  const prefs = useTerminalPrefs.getState().prefs;
  const profile = profileById(prefs);
  const effective: ShellSpec | null =
    spec ?? (profile.shell ? { program: profile.shell, args: [] } : null);
  return openTerminalTab({
    title,
    protocol: "local",
    profileId: profile.id,
    start: (cols, rows, cb) => ipc.openLocalSession(effective, cols, rows, cb),
  });
}

export function closeTab(tabId: string) {
  const id = backendIds.get(tabId);
  backendIds.delete(tabId);
  profiles.delete(tabId);
  untrack.get(tabId)?.();
  untrack.delete(tabId);
  if (id) ipc.sessionClose(id).catch(() => {});
  disposeTerminal(tabId);
  useSessions.getState().close(tabId);
}

export function backendSessionId(tabId: string): string | undefined {
  return backendIds.get(tabId);
}

/** Re-apply profiles and palettes to every open terminal (prefs or app theme changed). */
export function refreshTerminals() {
  const prefs = useTerminalPrefs.getState().prefs;
  for (const h of allTerminals()) {
    const profile = profileById(prefs, profiles.get(h.tabId));
    applyOptions(h, profile, paletteFor(profile));
  }
}

/** Send bytes to a tab's session (used by paste, snippets and broadcast). */
export function writeToTab(tabId: string, bytes: Uint8Array): Promise<void> {
  const id = backendIds.get(tabId);
  return id ? ipc.sessionWrite(id, bytes) : Promise.resolve();
}
