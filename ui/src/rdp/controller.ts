import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import * as ipc from "@/lib/ipc";
import type { RdpInput, RdpMessage, RdpOpened, RdpViewSize, SessionMessage } from "@/lib/ipc";
import { useNotifications } from "@/stores/notifications";
import { usePrompts } from "@/stores/prompts";
import { useRdp } from "@/stores/rdp";
import { useSessions } from "@/stores/sessions";
import { parseRdpBinary } from "./frames";

/**
 * Glue between RDP tabs and their backend sessions. Each tab owns a canvas that survives
 * view switches (the pane only attaches it); frames are drawn into it as they arrive.
 */

type Starter = (view: RdpViewSize, cb: ipc.RdpCallbacks) => Promise<RdpOpened>;

interface Live {
  sessionId?: string;
  canvas: HTMLCanvasElement;
  start: Starter;
  /** Input waiting for the next flush (mouse moves coalesced). */
  queue: RdpInput[];
  flushScheduled: boolean;
  /** Last clipboard text from the server, so it is not echoed back. */
  lastRemote?: string;
  /** Last local clipboard text sent to the server. */
  lastSent?: string;
}

const live = new Map<string, Live>();

const PHASES: Record<ipc.RdpPhase, string> = {
  connecting: "Connecting",
  securing: "Checking the certificate",
  authenticating: "Signing in",
};

function newTabId(): string {
  return `t-${crypto.randomUUID()}`;
}

/** The size to request for a new desktop: the session area, in device pixels. */
export function currentViewSize(): RdpViewSize {
  const area = document.querySelector<HTMLElement>("[data-session-area]");
  const dpr = window.devicePixelRatio || 1;
  const width = area && area.clientWidth > 0 ? area.clientWidth : window.innerWidth - 240;
  const height = area && area.clientHeight > 0 ? area.clientHeight : window.innerHeight - 96;
  return {
    width: Math.round(Math.max(200, width) * dpr),
    height: Math.round(Math.max(200, height) * dpr),
    scale: Math.round(dpr * 100),
  };
}

export function rdpCanvas(tabId: string): HTMLCanvasElement | undefined {
  return live.get(tabId)?.canvas;
}

export function rdpSessionId(tabId: string): string | undefined {
  return live.get(tabId)?.sessionId;
}

function draw(tabId: string, bytes: Uint8Array) {
  const l = live.get(tabId);
  const msg = parseRdpBinary(bytes);
  if (!l || !msg) return;
  if (msg.kind === "pointer") {
    useRdp.getState().patch(tabId, { cursor: cursorFor(msg) });
    return;
  }
  const canvas = l.canvas;
  if (canvas.width !== msg.width || canvas.height !== msg.height) {
    canvas.width = msg.width;
    canvas.height = msg.height;
    useRdp.getState().patch(tabId, { width: msg.width, height: msg.height });
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  for (const r of msg.rects) {
    ctx.putImageData(new ImageData(r.pixels, r.w, r.h), r.x, r.y);
  }
}

/** A CSS cursor from the server's pointer bitmap. */
function cursorFor(p: Extract<ReturnType<typeof parseRdpBinary>, { kind: "pointer" }>): string {
  if (p.width === 0 || p.height === 0) return "none";
  const c = document.createElement("canvas");
  c.width = p.width;
  c.height = p.height;
  const ctx = c.getContext("2d");
  if (!ctx) return "default";
  ctx.putImageData(new ImageData(new Uint8ClampedArray(p.pixels), p.width, p.height), 0, 0);
  try {
    return `url(${c.toDataURL()}) ${p.hotX} ${p.hotY}, default`;
  } catch {
    return "default";
  }
}

function onSshMessage(tabId: string, msg: SessionMessage) {
  const prompts = usePrompts.getState();
  switch (msg.type) {
    case "host_key":
      prompts.push({
        id: msg.promptId,
        tabId,
        type: "host_key",
        info: msg.info,
        status: msg.status,
        openssh: msg.openssh,
      });
      break;
    case "prompt":
      prompts.push({ id: msg.promptId, tabId, type: "prompt", prompt: msg.prompt });
      break;
    case "progress":
      if (msg.progress.phase !== "connected")
        useSessions
          .getState()
          .setState(
            tabId,
            "connecting",
            `SSH tunnel: ${msg.progress.phase} ${msg.progress.target}`,
          );
      break;
    default:
      break;
  }
}

function onMessage(tabId: string, msg: RdpMessage) {
  const sessions = useSessions.getState();
  switch (msg.type) {
    case "certificate":
      usePrompts.getState().push({
        id: msg.promptId,
        tabId,
        type: "certificate",
        cert: msg.cert,
        status: msg.status,
      });
      return;
    case "credentials":
      usePrompts.getState().push({
        id: msg.promptId,
        tabId,
        type: "prompt",
        prompt: { kind: "password", user: msg.username, target: msg.target },
      });
      return;
    case "ssh":
      onSshMessage(tabId, msg.message);
      return;
    case "event":
      break;
  }
  const e = msg.event;
  const l = live.get(tabId);
  switch (e.type) {
    case "progress":
      sessions.setState(tabId, "connecting", PHASES[e.phase]);
      break;
    case "connected":
      sessions.setState(tabId, "connected");
      useRdp.getState().patch(tabId, { width: e.width, height: e.height });
      break;
    case "resized":
      useRdp.getState().patch(tabId, { width: e.width, height: e.height });
      break;
    case "pointer_default":
      useRdp.getState().patch(tabId, { cursor: "default" });
      break;
    case "pointer_hidden":
      useRdp.getState().patch(tabId, { cursor: "none" });
      break;
    case "clipboard":
      if (l) l.lastRemote = e.text;
      writeText(e.text).catch(() => {});
      break;
    case "closed":
      if (l) l.sessionId = undefined;
      usePrompts.getState().dropTab(tabId);
      sessions.setState(tabId, e.graceful ? "disconnected" : "error", e.message);
      break;
  }
}

async function start(tabId: string) {
  const l = live.get(tabId);
  if (!l) return;
  useSessions.getState().setState(tabId, "connecting", "Connecting");
  try {
    const opened = await l.start(currentViewSize(), {
      onFrame: (bytes) => draw(tabId, bytes),
      onMessage: (msg) => onMessage(tabId, msg),
    });
    if (!live.has(tabId)) {
      // Closed while starting.
      void ipc.rdpClose(opened.sessionId).catch(() => {});
      return;
    }
    l.sessionId = opened.sessionId;
  } catch (e) {
    const err = ipc.CommandError.from(e);
    useSessions.getState().setState(tabId, "error", err.message);
  }
}

interface OpenOptions {
  title: string;
  device?: { id: number; vendor: string };
  /** The desktop follows the view size (no fixed resolution). */
  followView: boolean;
  clipboard: boolean;
  start: Starter;
}

function openRdpTab(opts: OpenOptions): string {
  const tabId = newTabId();
  const canvas = document.createElement("canvas");
  canvas.width = 0;
  canvas.height = 0;
  live.set(tabId, { canvas, start: opts.start, queue: [], flushScheduled: false });
  useRdp.getState().init(tabId, { followView: opts.followView, clipboard: opts.clipboard });
  useSessions.getState().open({
    id: tabId,
    title: opts.title,
    protocol: "rdp",
    state: "connecting",
    detail: "Connecting",
    device: opts.device,
  });
  void start(tabId);
  return tabId;
}

type RdpMethod = Extract<ipc.ConnectionMethod, { kind: "rdp" }>;

/** Open an inventory device's RDP connection method in a tab. */
export function openRdpDevice(
  device: { id: number; hostname: string; vendor: string },
  method: number,
  settings: RdpMethod,
): string {
  return openRdpTab({
    title: device.hostname,
    device: { id: device.id, vendor: device.vendor },
    followView: settings.width === 0,
    clipboard: settings.clipboard,
    start: (view, cb) => ipc.deviceRdpOpen(device.id, method, view, cb),
  });
}

/**
 * Open an ad-hoc RDP session. The password, if given, is sent once; a reconnect asks
 * again rather than keeping it in the frontend.
 */
export function openRdp(options: ipc.RdpOptions, credentialId: number | null = null): string {
  let first: ipc.RdpOptions | null = options;
  return openRdpTab({
    title: options.host,
    followView: options.width === 0,
    clipboard: options.clipboard,
    start: (view, cb) => {
      const o = first ?? { ...options, password: null };
      first = null;
      // A credential profile is resolved in Rust on every (re)connect.
      return ipc.rdpOpen(o, view, cb, credentialId);
    },
  });
}

/** Start a disconnected tab's session again (same canvas). */
export function reconnectRdp(tabId: string) {
  const l = live.get(tabId);
  if (!l || l.sessionId) return;
  void start(tabId);
}

function flush(tabId: string) {
  const l = live.get(tabId);
  if (!l) return;
  l.flushScheduled = false;
  const events = l.queue;
  l.queue = [];
  if (l.sessionId && events.length > 0) void ipc.rdpInput(l.sessionId, events).catch(() => {});
}

/** Queue input; consecutive mouse moves collapse to the latest. Sent once per frame. */
export function sendInput(tabId: string, event: RdpInput) {
  const l = live.get(tabId);
  if (!l?.sessionId) return;
  const last = l.queue[l.queue.length - 1];
  if (event.kind === "move" && last?.kind === "move") l.queue[l.queue.length - 1] = event;
  else l.queue.push(event);
  if (!l.flushScheduled) {
    l.flushScheduled = true;
    requestAnimationFrame(() => flush(tabId));
  }
}

export function resizeRdp(tabId: string, view: RdpViewSize) {
  const id = rdpSessionId(tabId);
  if (id) void ipc.rdpResize(id, view).catch(() => {});
}

export function ctrlAltDel(tabId: string) {
  const id = rdpSessionId(tabId);
  if (id) void ipc.rdpCtrlAltDel(id).catch(() => {});
}

/** Offer the local clipboard to the server if it changed (on focus). */
export async function syncClipboard(tabId: string) {
  const l = live.get(tabId);
  const ui = useRdp.getState().byTab[tabId];
  if (!l?.sessionId || !ui?.clipboard) return;
  let text: string;
  try {
    text = await readText();
  } catch {
    return;
  }
  if (!text || text === l.lastRemote || text === l.lastSent) return;
  l.lastSent = text;
  void ipc
    .rdpClipboard(l.sessionId, text)
    .catch((e: unknown) =>
      useNotifications.getState().notifyError(e, "Could not share the clipboard"),
    );
}

export function closeRdpTab(tabId: string) {
  const l = live.get(tabId);
  live.delete(tabId);
  if (l?.sessionId) void ipc.rdpClose(l.sessionId).catch(() => {});
  usePrompts.getState().dropTab(tabId);
  useRdp.getState().drop(tabId);
  useSessions.getState().close(tabId);
}
