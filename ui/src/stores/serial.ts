import { create } from "zustand";
import type { TransferVariant } from "@/lib/ipc";

/** Modem control lines as last set from the UI (ports open with both asserted). */
export interface SerialLines {
  dtr: boolean;
  rts: boolean;
}

export const DEFAULT_LINES: SerialLines = { dtr: true, rts: true };

export type TransferDirection = "send" | "receive";

export interface TransferState {
  direction: TransferDirection;
  variant: TransferVariant;
  phase: "running" | "done" | "failed" | "cancelled";
  bytes: number;
  total: number | null;
  /** Names sent, or paths saved. */
  files: string[];
  message?: string;
}

interface SerialStore {
  lines: Record<string, SerialLines>;
  transfers: Record<string, TransferState>;
  /** Tab whose transfer dialog is open. */
  dialogTab: string | null;
  dialogDirection: TransferDirection;
  setLines: (tabId: string, lines: Partial<SerialLines>) => void;
  resetLines: (tabId: string) => void;
  setTransfer: (tabId: string, t: TransferState | null) => void;
  openDialog: (tabId: string, direction: TransferDirection) => void;
  closeDialog: () => void;
  dropTab: (tabId: string) => void;
}

function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(rec).filter(([k]) => k !== key));
}

export const useSerial = create<SerialStore>((set, get) => ({
  lines: {},
  transfers: {},
  dialogTab: null,
  dialogDirection: "send",
  setLines: (tabId, lines) =>
    set({
      lines: { ...get().lines, [tabId]: { ...(get().lines[tabId] ?? DEFAULT_LINES), ...lines } },
    }),
  resetLines: (tabId) => set({ lines: { ...get().lines, [tabId]: DEFAULT_LINES } }),
  setTransfer: (tabId, t) =>
    set({ transfers: t ? { ...get().transfers, [tabId]: t } : without(get().transfers, tabId) }),
  openDialog: (tabId, direction) => set({ dialogTab: tabId, dialogDirection: direction }),
  closeDialog: () => set({ dialogTab: null }),
  dropTab: (tabId) =>
    set({
      lines: without(get().lines, tabId),
      transfers: without(get().transfers, tabId),
      dialogTab: get().dialogTab === tabId ? null : get().dialogTab,
    }),
}));
