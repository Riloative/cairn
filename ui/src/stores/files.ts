import { create } from "zustand";
import * as ipc from "@/lib/ipc";
import type { RemoteEntry } from "@/lib/ipc";
import { useNotifications } from "./notifications";

/** Per-tab state of the file panel. */
export interface PanelState {
  open: boolean;
  /** "sftp": browse the device; "scp": enter remote paths (devices without SFTP). */
  mode: "sftp" | "scp";
  path: string | null;
  entries: RemoteEntry[] | null;
  loading: boolean;
  error: string | null;
}

export interface TransferItem {
  id: string;
  tabId: string;
  sessionId: string;
  protocol: "sftp" | "scp";
  direction: "upload" | "download";
  localPath: string;
  remotePath: string;
  /** Display name (file name). */
  name: string;
  size: number | null;
  bytes: number;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  error: string | null;
}

const PANEL: PanelState = {
  open: false,
  mode: "sftp",
  path: null,
  entries: null,
  loading: false,
  error: null,
};

interface FilesState {
  panels: Record<string, PanelState>;
  queue: TransferItem[];
  panel: (tabId: string) => PanelState;
  toggle: (tabId: string, sessionId: string | undefined) => void;
  setMode: (tabId: string, mode: PanelState["mode"]) => void;
  /** List `path` (default: the login folder). */
  browse: (tabId: string, sessionId: string, path?: string) => Promise<void>;
  enqueue: (items: Omit<TransferItem, "id" | "bytes" | "state" | "error">[]) => void;
  cancel: (id: string) => void;
  clearFinished: () => void;
  dropTab: (tabId: string) => void;
}

let nextId = 1;
let pumping = false;

function patchPanel(tabId: string, p: Partial<PanelState>) {
  const panels = useFiles.getState().panels;
  useFiles.setState({ panels: { ...panels, [tabId]: { ...(panels[tabId] ?? PANEL), ...p } } });
}

function patchItem(id: string, p: Partial<TransferItem>) {
  useFiles.setState({
    queue: useFiles.getState().queue.map((t) => (t.id === id ? { ...t, ...p } : t)),
  });
}

/** Run queued transfers one at a time (devices handle parallel transfers poorly). */
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const next = useFiles.getState().queue.find((t) => t.state === "queued");
      if (!next) break;
      patchItem(next.id, { state: "running" });
      try {
        const bytes = await ipc.fileTransfer(
          next.sessionId,
          {
            id: next.id,
            protocol: next.protocol,
            direction: next.direction,
            localPath: next.localPath,
            remotePath: next.remotePath,
          },
          (b) => patchItem(next.id, { bytes: b }),
        );
        patchItem(next.id, { state: "done", bytes });
        // Show uploads in the folder the user is looking at.
        if (next.direction === "upload") {
          const panel = useFiles.getState().panels[next.tabId];
          if (panel?.open && panel.path && next.remotePath.startsWith(panel.path))
            void useFiles.getState().browse(next.tabId, next.sessionId, panel.path);
        }
      } catch (e) {
        const err = ipc.CommandError.from(e);
        const cancelled = err.code === "ssh.cancelled";
        patchItem(next.id, {
          state: cancelled ? "cancelled" : "failed",
          error: cancelled ? null : err.hint ? `${err.message} ${err.hint}` : err.message,
        });
      }
    }
  } finally {
    pumping = false;
  }
}

export const useFiles = create<FilesState>((set, get) => ({
  panels: {},
  queue: [],
  panel: (tabId) => get().panels[tabId] ?? PANEL,
  toggle: (tabId, sessionId) => {
    const p = get().panel(tabId);
    patchPanel(tabId, { open: !p.open });
    if (!p.open && p.mode === "sftp" && p.entries === null && sessionId)
      void get().browse(tabId, sessionId);
  },
  setMode: (tabId, mode) => patchPanel(tabId, { mode }),
  browse: async (tabId, sessionId, path) => {
    patchPanel(tabId, { loading: true, error: null });
    try {
      const target = path ?? (await ipc.sftpHome(sessionId));
      const entries = await ipc.sftpList(sessionId, target);
      patchPanel(tabId, { path: target, entries, loading: false });
    } catch (e) {
      const err = ipc.CommandError.from(e);
      patchPanel(tabId, {
        loading: false,
        error: err.hint ? `${err.message} ${err.hint}` : err.message,
        // SFTP-less devices: offer SCP straight away.
        ...(err.code === "ssh.sftp_unavailable" ? { mode: "scp" as const } : {}),
      });
    }
  },
  enqueue: (items) => {
    const added = items.map((i) => ({
      ...i,
      id: `t${nextId++}`,
      bytes: 0,
      state: "queued" as const,
      error: null,
    }));
    set({ queue: [...get().queue, ...added] });
    void pump();
  },
  cancel: (id) => {
    const item = get().queue.find((t) => t.id === id);
    if (!item) return;
    if (item.state === "queued") patchItem(id, { state: "cancelled" });
    else if (item.state === "running")
      ipc
        .fileTransferCancel(id)
        .catch((e: unknown) =>
          useNotifications.getState().notifyError(e, "Could not cancel the transfer"),
        );
  },
  clearFinished: () =>
    set({ queue: get().queue.filter((t) => t.state === "queued" || t.state === "running") }),
  dropTab: (tabId) => {
    const panels = Object.fromEntries(Object.entries(get().panels).filter(([id]) => id !== tabId));
    set({
      panels,
      queue: get().queue.map((t) =>
        t.tabId === tabId && t.state === "queued" ? { ...t, state: "cancelled" } : t,
      ),
    });
  },
}));
