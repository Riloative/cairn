import { create } from "zustand";

export interface PendingPaste {
  tabId: string;
  text: string;
  resolve: (decision: "paste" | "slow" | "cancel") => void;
}

interface TerminalUiState {
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  pendingPaste: PendingPaste | null;
  /** Ask the user to confirm a multi-line paste. */
  confirmPaste: (tabId: string, text: string) => Promise<"paste" | "slow" | "cancel">;
  resolvePaste: (decision: "paste" | "slow" | "cancel") => void;
  overviewOpen: boolean;
  setOverviewOpen: (open: boolean) => void;
}

export const useTerminalUi = create<TerminalUiState>((set, get) => ({
  searchOpen: false,
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  pendingPaste: null,
  confirmPaste: (tabId, text) =>
    new Promise((resolve) => {
      get().pendingPaste?.resolve("cancel");
      set({ pendingPaste: { tabId, text, resolve } });
    }),
  resolvePaste: (decision) => {
    const p = get().pendingPaste;
    set({ pendingPaste: null });
    p?.resolve(decision);
  },
  overviewOpen: false,
  setOverviewOpen: (overviewOpen) => set({ overviewOpen }),
}));
