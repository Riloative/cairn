import { create } from "zustand";

export type View = "sessions" | "inventory" | "map" | "audit" | "settings";

interface UiState {
  view: View;
  paletteOpen: boolean;
  notificationsOpen: boolean;
  setView: (view: View) => void;
  setPaletteOpen: (open: boolean) => void;
  setNotificationsOpen: (open: boolean) => void;
}

export const useUi = create<UiState>((set) => ({
  view: "sessions",
  paletteOpen: false,
  notificationsOpen: false,
  setView: (view) => set({ view }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setNotificationsOpen: (notificationsOpen) => set({ notificationsOpen }),
}));
