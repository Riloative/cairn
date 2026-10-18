import { openUrl } from "@tauri-apps/plugin-opener";
import * as ipc from "@/lib/ipc";
import type {
  CloseReason,
  ConnectOptions,
  ConnectProgress,
  SessionMessage,
  ShellSpec,
  TerminalProfile,
} from "@/lib/ipc";
import { THEMES } from "@/lib/theme";
import { useNotifications } from "@/stores/notifications";
import { usePrompts } from "@/stores/prompts";
import { backoffDelay, useReconnect } from "@/stores/reconnect";
import { useSessions, type SessionProtocol } from "@/stores/sessions";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { customPalettes, profileById, useTerminalPrefs } from "@/stores/terminalPrefs";
import { encodeBinary, encodeInput } from "./encoding";
import { desktopNotify } from "./notify";
import type { Palette } from "./palette";
import { defaultPaletteFor, findPalette } from "./palettes";
import { rulesForVendor, type CompiledRule } from "./highlight/engine";
import { Highlighter } from "./highlight/highlighter";
import { BUILTIN_RULESETS } from "./highlight/rulesets";
import { compilePatterns, trackPrivilege } from "./privilege";
import {
  allTerminals,
  applyOptions,
  createTerminal,
  disposeTerminal,
  getTerminal,
  type TerminalHandle,
} from "./registry";

/**
 * Glue between session tabs, backend sessions and xterm instances. Backend ids are
 * tracked per tab here; the sessions store only holds what the UI renders.
 */
const backendIds = new Map<string, string>();
const profiles = new Map<string, string>();
const untrack = new Map<string, () => void>();
/** SSH connection handles (options and credentials stay in Rust). */
const connections = new Map<string, string>();
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const highlighters = new Map<string, Highlighter>();
/** Compiled rules per vendor, invalidated when prefs change. */
const ruleCache = new Map<string, CompiledRule[]>();

function rulesFor(tabId: string): CompiledRule[] {
  const prefs = useTerminalPrefs.getState().prefs;
  if (!prefs.highlightEnabled) return [];
  const vendor = tabOf(tabId)?.vendor ?? "generic";
  let rules = ruleCache.get(vendor);
  if (!rules) {
    rules = rulesForVendor(vendor, BUILTIN_RULESETS, prefs.highlightSets);
    ruleCache.set(vendor, rules);
  }
  return rules;
}

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

function tabOf(tabId: string) {
  return useSessions.getState().tabs.find((t) => t.id === tabId);
}

/** Dim status line written into the terminal view only (never into logs/recordings). */
function statusLine(handle: TerminalHandle | undefined, text: string) {
  handle?.term.write(`\r\n\x1b[2m[${text}]\x1b[0m\r\n`);
}

export function describeClose(reason: CloseReason): string {
  switch (reason.kind) {
    case "exited":
      return reason.code === null ? "Session ended" : `Session ended with code ${reason.code}`;
    case "closed":
      return "Session closed";
    case "error":
      return reason.message;
  }
}

function describeProgress(p: ConnectProgress): string {
  switch (p.phase) {
    case "connecting":
      return p.index === 0 ? `Connecting to ${p.target}` : `Hopping to ${p.target}`;
    case "authenticating":
      return `Authenticating as ${p.user} on ${p.target}`;
    case "connected":
      return p.host_key ? `${p.host_key.keyType} ${p.host_key.fingerprint}` : "Connected";
  }
}

function onProgress(tabId: string, p: ConnectProgress) {
  if (p.phase === "connected") {
    useReconnect.getState().clear(tabId);
    useSessions.getState().setState(tabId, "connected", describeProgress(p));
  } else {
    useSessions.getState().setState(tabId, "connecting", describeProgress(p));
  }
}

function onClosed(tabId: string, reason: CloseReason) {
  backendIds.delete(tabId);
  usePrompts.getState().dropTab(tabId);
  const handle = getTerminal(tabId);
  const tab = tabOf(tabId);
  if (!tab) return;
  if (tab.protocol === "local" && reason.kind === "exited" && reason.code === 0) {
    // `exit` in a local shell closes the tab, like other terminals.
    closeTab(tabId);
    return;
  }
  const message = describeClose(reason);
  const unexpected = reason.kind === "error";
  useSessions.getState().setState(tabId, unexpected ? "error" : "disconnected", message);
  statusLine(handle, message);

  if (!unexpected) return;
  const inactive = document.hidden || useSessions.getState().activeId !== tabId;
  if (useSettings.getState().settings?.notifyOnDisconnect !== false && inactive) {
    void desktopNotify(`${tab.title} disconnected`, message);
  }
  if (connections.has(tabId)) scheduleReconnect(tabId, message);
}

function onMessage(tabId: string, msg: SessionMessage) {
  switch (msg.type) {
    case "progress":
      onProgress(tabId, msg.progress);
      break;
    case "host_key":
      usePrompts.getState().push({
        id: msg.promptId,
        tabId,
        type: "host_key",
        info: msg.info,
        status: msg.status,
        openssh: msg.openssh,
      });
      break;
    case "prompt":
      usePrompts.getState().push({ id: msg.promptId, tabId, type: "prompt", prompt: msg.prompt });
      break;
    case "closed":
      onClosed(tabId, msg.reason);
      break;
  }
}

function wireInput(tabId: string, handle: TerminalHandle) {
  const send = (bytes: Uint8Array) => {
    const id = backendIds.get(tabId);
    if (!id) return;
    ipc.sessionWrite(id, bytes).catch(() => {
      // The session may have just closed; the close message updates the tab.
    });
  };
  handle.term.onData((d) => {
    // Enter on a dropped SSH session reconnects immediately.
    if (!backendIds.has(tabId) && connections.has(tabId) && d === "\r") {
      void reconnectTab(tabId);
      return;
    }
    send(encodeInput(d));
  });
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

function callbacks(tabId: string): ipc.SessionCallbacks {
  return {
    // xterm parses on its own schedule; writes are queued in order.
    onData: (bytes) => getTerminal(tabId)?.term.write(bytes),
    onMessage: (msg) => onMessage(tabId, msg),
  };
}

interface OpenOptions {
  title: string;
  protocol: SessionProtocol;
  /** Highlighting vendor (defaults to generic). */
  vendor?: string;
  profileId?: string | null;
  /** True when the session is usable as soon as `start` resolves (local shells). */
  readyOnStart: boolean;
  /** Starts the backend session; returns its id. */
  start: (tabId: string, cols: number, rows: number, cb: ipc.SessionCallbacks) => Promise<string>;
}

export async function openTerminalTab(opts: OpenOptions): Promise<string> {
  const prefs = useTerminalPrefs.getState().prefs;
  const profile = profileById(prefs, opts.profileId);
  const tabId = newTabId();
  const handle = createTerminal(tabId, profile, paletteFor(profile), openLink);
  profiles.set(tabId, profile.id);
  wireInput(tabId, handle);
  untrack.set(tabId, trackPrivilege(tabId, handle.term, privilegePatterns));
  highlighters.set(
    tabId,
    new Highlighter(
      handle.term,
      () => rulesFor(tabId),
      () => paletteFor(profileById(useTerminalPrefs.getState().prefs, profiles.get(tabId))).colors,
    ),
  );
  useSessions.getState().open({
    id: tabId,
    title: opts.title,
    protocol: opts.protocol,
    state: "connecting",
    vendor: opts.vendor ?? "generic",
  });
  try {
    const id = await opts.start(tabId, handle.term.cols, handle.term.rows, callbacks(tabId));
    if (!tabOf(tabId)) {
      // Closed while starting.
      void ipc.sessionClose(id).catch(() => {});
      return tabId;
    }
    backendIds.set(tabId, id);
    // The pane may have been fitted while the session was starting.
    ipc.sessionResize(id, handle.term.cols, handle.term.rows).catch(() => {});
    if (opts.readyOnStart) useSessions.getState().setState(tabId, "connected");
  } catch (e) {
    const err = ipc.CommandError.from(e);
    useSessions.getState().setState(tabId, "error", err.message);
    statusLine(handle, err.hint ? `${err.message} ${err.hint}` : err.message);
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
    readyOnStart: true,
    start: (_tabId, cols, rows, cb) => ipc.openLocalSession(effective, cols, rows, cb),
  });
}

/** Open an SSH session. Credentials in `options` are handed to Rust and not kept here. */
export function openSsh(
  options: ConnectOptions,
  title: string,
  extra: { profileId?: string | null; vendor?: string } = {},
) {
  return openTerminalTab({
    title,
    protocol: "ssh",
    profileId: extra.profileId,
    vendor: extra.vendor,
    readyOnStart: false,
    start: async (tabId, cols, rows, cb) => {
      const opened = await ipc.sshOpen(options, cols, rows, cb);
      connections.set(tabId, opened.connectionId);
      return opened.sessionId;
    },
  });
}

function scheduleReconnect(tabId: string, message: string) {
  const prev = useReconnect.getState().byTab[tabId];
  const attempt = prev?.attempt ?? 0;
  const delay = backoffDelay(attempt);
  clearTimeout(reconnectTimers.get(tabId));
  if (delay === null) {
    useReconnect.getState().set(tabId, { attempt, nextAt: null, message });
    return;
  }
  useReconnect.getState().set(tabId, { attempt, nextAt: Date.now() + delay, message });
  reconnectTimers.set(
    tabId,
    setTimeout(() => void reconnectTab(tabId, { automatic: true }), delay),
  );
}

/** Stop automatic reconnect attempts for a tab (the overlay stays, with a button). */
export function cancelAutoReconnect(tabId: string) {
  clearTimeout(reconnectTimers.get(tabId));
  reconnectTimers.delete(tabId);
  const s = useReconnect.getState().byTab[tabId];
  if (s) useReconnect.getState().set(tabId, { ...s, nextAt: null });
}

/** Reconnect a dropped SSH tab, reusing its terminal. */
export async function reconnectTab(tabId: string, opts: { automatic?: boolean } = {}) {
  const connectionId = connections.get(tabId);
  const handle = getTerminal(tabId);
  if (!connectionId || !handle || backendIds.has(tabId)) return;
  clearTimeout(reconnectTimers.get(tabId));
  const prev = useReconnect.getState().byTab[tabId];
  const attempt = opts.automatic ? (prev?.attempt ?? 0) + 1 : 0;
  useReconnect.getState().set(tabId, { attempt, nextAt: null, message: prev?.message ?? "" });
  useSessions.getState().setState(tabId, "connecting", "Reconnecting");
  statusLine(handle, "Reconnecting…");
  try {
    const id = await ipc.sshReconnect(
      connectionId,
      handle.term.cols,
      handle.term.rows,
      callbacks(tabId),
    );
    if (!tabOf(tabId)) {
      void ipc.sessionClose(id).catch(() => {});
      return;
    }
    backendIds.set(tabId, id);
  } catch (e) {
    const err = ipc.CommandError.from(e);
    useSessions.getState().setState(tabId, "error", err.message);
    scheduleReconnect(tabId, err.message);
  }
}

export function closeTab(tabId: string) {
  const id = backendIds.get(tabId);
  backendIds.delete(tabId);
  profiles.delete(tabId);
  untrack.get(tabId)?.();
  untrack.delete(tabId);
  highlighters.get(tabId)?.dispose();
  highlighters.delete(tabId);
  clearTimeout(reconnectTimers.get(tabId));
  reconnectTimers.delete(tabId);
  useReconnect.getState().clear(tabId);
  usePrompts.getState().dropTab(tabId);
  const connectionId = connections.get(tabId);
  connections.delete(tabId);
  if (connectionId) ipc.sshForget(connectionId).catch(() => {});
  if (id) ipc.sessionClose(id).catch(() => {});
  disposeTerminal(tabId);
  useSessions.getState().close(tabId);
}

/**
 * Give keyboard focus back to the active terminal (after the palette or a dialog closes),
 * unless another dialog has taken focus in the meantime.
 */
export function focusActiveTerminal() {
  requestAnimationFrame(() => {
    const id = useSessions.getState().activeId;
    if (!id || useUi.getState().view !== "sessions") return;
    if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
    getTerminal(id)?.term.focus();
  });
}

export function backendSessionId(tabId: string): string | undefined {
  return backendIds.get(tabId);
}

export function canReconnect(tabId: string): boolean {
  return connections.has(tabId) && !backendIds.has(tabId);
}

/** Re-apply profiles, palettes and highlighting to every open terminal. */
export function refreshTerminals() {
  const prefs = useTerminalPrefs.getState().prefs;
  ruleCache.clear();
  for (const h of allTerminals()) {
    const profile = profileById(prefs, profiles.get(h.tabId));
    applyOptions(h, profile, paletteFor(profile));
    highlighters.get(h.tabId)?.reset();
  }
}

/** Switch the highlighting rule set of a tab. */
export function setTabVendor(tabId: string, vendor: string) {
  useSessions.getState().setVendor(tabId, vendor);
  highlighters.get(tabId)?.reset();
}

/** Send bytes to a tab's session (used by paste, snippets and broadcast). */
export function writeToTab(tabId: string, bytes: Uint8Array): Promise<void> {
  const id = backendIds.get(tabId);
  return id ? ipc.sessionWrite(id, bytes) : Promise.resolve();
}
