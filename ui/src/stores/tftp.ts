import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import * as ipc from "@/lib/ipc";
import type { TftpLogEntry, TftpPrefs, TftpStatus } from "@/lib/ipc";
import { useNotifications } from "./notifications";

interface TftpState {
  status: TftpStatus | null;
  busy: boolean;
  load: () => Promise<void>;
  start: (prefs: TftpPrefs) => Promise<boolean>;
  stop: () => Promise<void>;
  clearLog: () => Promise<void>;
  /** Merge a live log update (by id; refused entries are prepended). */
  applyEntry: (entry: TftpLogEntry) => void;
}

export const useTftp = create<TftpState>((set, get) => ({
  status: null,
  busy: false,
  load: async () => {
    try {
      set({ status: await ipc.tftpStatus() });
    } catch (e) {
      useNotifications.getState().notifyError(e, "Could not read the TFTP server status");
    }
  },
  start: async (prefs) => {
    set({ busy: true });
    try {
      set({ status: await ipc.tftpStart(prefs) });
      return true;
    } catch (e) {
      useNotifications.getState().notifyError(e, "Could not start the TFTP server");
      return false;
    } finally {
      set({ busy: false });
    }
  },
  stop: async () => {
    set({ busy: true });
    try {
      set({ status: await ipc.tftpStop() });
    } catch (e) {
      useNotifications.getState().notifyError(e, "Could not stop the TFTP server");
    } finally {
      set({ busy: false });
    }
  },
  clearLog: async () => {
    await ipc.tftpClearLog().catch(() => {});
    await get().load();
  },
  applyEntry: (entry) => {
    const status = get().status;
    if (!status) return;
    const idx = entry.id ? status.log.findIndex((e) => e.id === entry.id) : -1;
    const log =
      idx >= 0
        ? status.log.map((e, i) => (i === idx ? entry : e))
        : [entry, ...status.log].slice(0, 200);
    set({ status: { ...status, log } });
  },
}));

/** Subscribe to live transfer updates; returns the unlisten function. */
export function watchTftp(): Promise<() => void> {
  return listen<TftpLogEntry>(ipc.TFTP_TRANSFER_EVENT, (e) =>
    useTftp.getState().applyEntry(e.payload),
  );
}
