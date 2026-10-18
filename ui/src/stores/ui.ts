import { create } from "zustand";

export type View = "sessions" | "inventory" | "map" | "audit" | "settings";
export type ConnectProtocol = "ssh" | "telnet" | "serial";

interface UiState {
  view: View;
  paletteOpen: boolean;
  notificationsOpen: boolean;
  quickConnectOpen: boolean;
  /** Tab shown in the connect dialog. */
  connectProtocol: ConnectProtocol;
  setQuickConnectOpen: (open: boolean) => void;
  setConnectProtocol: (protocol: ConnectProtocol) => void;
  /** Open the connect dialog on a protocol's tab. */
  openConnect: (protocol: ConnectProtocol) => void;
  setView: (view: View) => void;
  setPaletteOpen: (open: boolean) => void;
  setNotificationsOpen: (open: boolean) => void;
}

export const useUi = create<UiState>((set) => ({
  view: "sessions",
  paletteOpen: false,
  notificationsOpen: false,
  quickConnectOpen: false,
  connectProtocol: "ssh",
  setQuickConnectOpen: (quickConnectOpen) => set({ quickConnectOpen }),
  setConnectProtocol: (connectProtocol) => set({ connectProtocol }),
  openConnect: (connectProtocol) => set({ connectProtocol, quickConnectOpen: true }),
  setView: (view) => set({ view }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setNotificationsOpen: (notificationsOpen) => set({ notificationsOpen }),
}));
