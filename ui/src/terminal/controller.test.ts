import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "@/lib/ipc";
import type { SessionCallbacks, TelnetRequest } from "@/lib/ipc";
import { useBroadcast } from "@/stores/broadcast";
import { useReconnect } from "@/stores/reconnect";
import { useSessions } from "@/stores/sessions";
import { FakeBackend } from "@/test/fakeBackend";
import {
  RESIZE_DEBOUNCE_MS,
  backendSessionId,
  cancelAutoReconnect,
  canReconnect,
  closeTab,
  openLocalShell,
  openTelnet,
  trailingDebounce,
  writeToTab,
} from "./controller";
import { disposeTerminal, getTerminal } from "./registry";
import type { TerminalHandle } from "./registry";

/**
 * Terminals are real (unopened) xterm instances so input, resize and parser events
 * behave as in the app; the registry around them is replaced so nothing touches the
 * DOM renderer.
 */
vi.mock("./registry", () => {
  const handles = new Map<string, TerminalHandle>();
  return {
    createTerminal: vi.fn((tabId: string, _p: unknown, _pal: unknown, onLink: () => void) => {
      const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
      const handle: TerminalHandle = {
        tabId,
        term,
        fit: new FitAddon(),
        search: new SearchAddon(),
        serialize: new SerializeAddon(),
        element: document.createElement("div"),
        opened: false,
        webgl: null,
        onLink,
      };
      handles.set(tabId, handle);
      return handle;
    }),
    getTerminal: (tabId: string) => handles.get(tabId),
    allTerminals: () => [...handles.values()],
    disposeTerminal: vi.fn((tabId: string) => {
      handles.get(tabId)?.term.dispose();
      handles.delete(tabId);
    }),
    applyOptions: vi.fn(),
    ensureOpened: vi.fn(),
    paintHost: vi.fn(),
    promoteRenderer: vi.fn(),
  };
});

/** Backend session ids handed out by the mocked open commands, reset per test. */
const ids = vi.hoisted(() => ({ next: 0 }));

/** Session commands carry binary channels and bodies the Tauri mock cannot route. */
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof ipc>();
  return {
    ...actual,
    openLocalSession: vi.fn(async () => `s${++ids.next}`),
    telnetOpen: vi.fn(async () => `s${++ids.next}`),
    sessionWrite: vi.fn(async () => {}),
    sessionResize: vi.fn(async () => {}),
    sessionClose: vi.fn(async () => {}),
    sshForget: vi.fn(async () => {}),
  };
});

const ipcMock = vi.mocked(ipc);
let backend: FakeBackend;

const flush = () => new Promise((r) => setTimeout(r, 0));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const writes = () => ipcMock.sessionWrite.mock.calls.map(([id, b]) => [id, text(b)]);
const resizes = () => ipcMock.sessionResize.mock.calls;
const request: TelnetRequest = {
  host: "10.0.0.5",
  port: 23,
  raw: false,
  console: null,
  connectTimeoutSecs: 10,
};
/** The callbacks the controller handed to the n-th telnet open (0-based). */
const telnetCallbacks = (n: number): SessionCallbacks => ipcMock.telnetOpen.mock.calls[n]![3];

beforeEach(() => {
  backend = new FakeBackend("unlocked");
  ids.next = 0;
  useSessions.setState({ tabs: [], activeId: null });
  useBroadcast.setState({ members: [], startedAt: null, pickerOpen: false });
  useReconnect.setState({ byTab: {} });
  for (const fn of [
    ipcMock.openLocalSession,
    ipcMock.telnetOpen,
    ipcMock.sessionWrite,
    ipcMock.sessionResize,
    ipcMock.sessionClose,
  ])
    fn.mockClear();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const t of useSessions.getState().tabs) closeTab(t.id);
  await flush();
  backend.dispose();
});

describe("trailingDebounce", () => {
  beforeEach(() => vi.useFakeTimers());

  it("collapses a burst into one call with the last arguments", () => {
    const fn = vi.fn();
    const d = trailingDebounce(fn, 50);
    d.call(1);
    d.call(2);
    vi.advanceTimersByTime(49);
    d.call(3);
    vi.advanceTimersByTime(49);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(3);
  });

  it("flushes on demand and cancels cleanly", () => {
    const fn = vi.fn();
    const d = trailingDebounce(fn, 50);
    d.call("a");
    d.flush();
    expect(fn).toHaveBeenCalledWith("a");
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    d.call("b");
    d.cancel();
    vi.advanceTimersByTime(100);
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("local shells", () => {
  it("opens a tab, maps its backend session and sends the real size", async () => {
    const tabId = await openLocalShell();
    const tab = useSessions.getState().tabs.find((t) => t.id === tabId);
    expect(tab).toMatchObject({ protocol: "local", state: "connected", title: "Local shell" });
    expect(useSessions.getState().activeId).toBe(tabId);
    expect(backendSessionId(tabId)).toBe("s1");
    expect(ipcMock.openLocalSession).toHaveBeenCalledTimes(1);
    expect(ipcMock.openLocalSession.mock.calls[0]!.slice(0, 3)).toEqual([null, 80, 24]);
    expect(resizes()).toEqual([["s1", 80, 24]]);
    expect(canReconnect(tabId)).toBe(false);
  });

  it("sends typed input to the backend session", async () => {
    const tabId = await openLocalShell();
    getTerminal(tabId)!.term.input("ls\r");
    await flush();
    expect(writes()).toEqual([["s1", "ls\r"]]);
  });

  it("debounces pty resizes and sends the size the terminal settles on", async () => {
    const tabId = await openLocalShell();
    vi.useFakeTimers();
    const term = getTerminal(tabId)!.term;
    term.resize(100, 30);
    term.resize(120, 40);
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS - 1);
    expect(resizes()).toEqual([["s1", 80, 24]]);
    vi.advanceTimersByTime(1);
    expect(resizes()).toEqual([
      ["s1", 80, 24],
      ["s1", 120, 40],
    ]);
  });

  it("closing a tab closes the session, drops the terminal and pending work", async () => {
    const tabId = await openLocalShell();
    vi.useFakeTimers();
    getTerminal(tabId)!.term.resize(100, 30);
    closeTab(tabId);
    expect(ipcMock.sessionClose).toHaveBeenCalledWith("s1");
    expect(vi.mocked(disposeTerminal)).toHaveBeenCalledWith(tabId);
    expect(getTerminal(tabId)).toBeUndefined();
    expect(backendSessionId(tabId)).toBeUndefined();
    expect(useSessions.getState().tabs).toEqual([]);
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS * 2);
    expect(resizes()).toEqual([["s1", 80, 24]]);
  });

  it("drops the session when the tab was closed while it was starting", async () => {
    let release: (id: string) => void = () => {};
    ipcMock.openLocalSession.mockImplementationOnce(
      () => new Promise<string>((resolve) => (release = resolve)),
    );
    const opening = openLocalShell();
    await flush();
    const tabId = useSessions.getState().tabs[0]!.id;
    closeTab(tabId);
    release("late");
    await opening;
    expect(ipcMock.sessionClose).toHaveBeenCalledWith("late");
    expect(backendSessionId(tabId)).toBeUndefined();
  });
});

describe("dropped sessions", () => {
  it("schedules an automatic reconnect with backoff after an unexpected close", async () => {
    vi.useFakeTimers();
    const tabId = await openTelnet(request, "cs1");
    expect(backendSessionId(tabId)).toBe("s1");
    telnetCallbacks(0).onMessage({ type: "connected" });
    expect(useSessions.getState().tabs[0]?.state).toBe("connected");

    telnetCallbacks(0).onMessage({
      type: "closed",
      reason: { kind: "error", message: "Connection reset" },
    });
    expect(useSessions.getState().tabs[0]).toMatchObject({
      state: "error",
      detail: "Connection reset",
    });
    expect(backendSessionId(tabId)).toBeUndefined();
    expect(canReconnect(tabId)).toBe(true);
    expect(useReconnect.getState().byTab[tabId]).toMatchObject({
      attempt: 0,
      nextAt: Date.now() + 2000,
      message: "Connection reset",
    });

    await vi.advanceTimersByTimeAsync(2000);
    expect(ipcMock.telnetOpen).toHaveBeenCalledTimes(2);
    expect(backendSessionId(tabId)).toBe("s2");
    expect(useReconnect.getState().byTab[tabId]).toMatchObject({ attempt: 1, nextAt: null });
    expect(useSessions.getState().tabs[0]).toMatchObject({
      state: "connecting",
      detail: "Reconnecting",
    });
    telnetCallbacks(1).onMessage({ type: "connected" });
    expect(useReconnect.getState().byTab[tabId]).toBeUndefined();
    expect(useSessions.getState().tabs[0]?.state).toBe("connected");
  });

  it("cancelling automatic reconnect keeps the tab reconnectable by hand", async () => {
    vi.useFakeTimers();
    const tabId = await openTelnet(request, "cs1");
    telnetCallbacks(0).onMessage({
      type: "closed",
      reason: { kind: "error", message: "Connection reset" },
    });
    cancelAutoReconnect(tabId);
    expect(useReconnect.getState().byTab[tabId]).toMatchObject({ attempt: 0, nextAt: null });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ipcMock.telnetOpen).toHaveBeenCalledTimes(1);
    expect(canReconnect(tabId)).toBe(true);

    // Enter on the dropped session reconnects right away.
    getTerminal(tabId)!.term.input("\r");
    await vi.advanceTimersByTimeAsync(0);
    expect(ipcMock.telnetOpen).toHaveBeenCalledTimes(2);
    expect(ipcMock.sessionWrite).not.toHaveBeenCalled();
  });

  it("does not reconnect after a clean close", async () => {
    vi.useFakeTimers();
    const tabId = await openTelnet(request, "cs1");
    telnetCallbacks(0).onMessage({ type: "closed", reason: { kind: "closed" } });
    expect(useSessions.getState().tabs[0]).toMatchObject({
      state: "disconnected",
      detail: "Session closed",
    });
    expect(useReconnect.getState().byTab[tabId]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ipcMock.telnetOpen).toHaveBeenCalledTimes(1);
  });
});

describe("broadcast", () => {
  it("mirrors input to member tabs only", async () => {
    const a = await openLocalShell(null, "a");
    const b = await openLocalShell(null, "b");
    await openLocalShell(null, "c");
    useBroadcast.getState().start([a, b]);
    await writeToTab(a, new TextEncoder().encode("show ver\r"));
    expect(writes()).toEqual([
      ["s1", "show ver\r"],
      ["s2", "show ver\r"],
    ]);
    ipcMock.sessionWrite.mockClear();
    // A non-member's input stays its own.
    await writeToTab(useSessions.getState().tabs[2]!.id, new TextEncoder().encode("x"));
    expect(writes()).toEqual([["s3", "x"]]);
    ipcMock.sessionWrite.mockClear();
    useBroadcast.getState().stop();
    await writeToTab(a, new TextEncoder().encode("y"));
    expect(writes()).toEqual([["s1", "y"]]);
  });
});
