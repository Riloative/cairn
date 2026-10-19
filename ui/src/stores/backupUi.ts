import { create } from "zustand";

/** Which data dialog is open (reachable from Settings and the command palette). */
export type DataDialog = "backup" | "restore" | "export" | null;

export const useDataDialog = create<{ open: DataDialog; set: (d: DataDialog) => void }>((set) => ({
  open: null,
  set: (open) => set({ open }),
}));
