import { create } from "zustand";

export type View = "sessions" | "inventory" | "map" | "audit" | "tools" | "settings";
export type ToolsTab = "tftp" | "forwards";
export type ConnectProtocol = "ssh" | "telnet" | "serial" | "rdp";

interface UiState {
  view: View;
  paletteOpen: boolean;
  notificationsOpen: boolean;
  shortcutsOpen: boolean;
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
  setShortcutsOpen: (open: boolean) => void;
  toolsTab: ToolsTab;
  setToolsTab: (tab: ToolsTab) => void;
  /** Show a tools tab. */
  openTool: (tab: ToolsTab) => void;
}

export const useUi = create<UiState>((set) => ({
  view: "sessions",
  paletteOpen: false,
  notificationsOpen: false,
  shortcutsOpen: false,
  quickConnectOpen: false,
  connectProtocol: "ssh",
  setQuickConnectOpen: (quickConnectOpen) => set({ quickConnectOpen }),
  setConnectProtocol: (connectProtocol) => set({ connectProtocol }),
  openConnect: (connectProtocol) => set({ connectProtocol, quickConnectOpen: true }),
  setView: (view) => set({ view }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setNotificationsOpen: (notificationsOpen) => set({ notificationsOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  toolsTab: "tftp",
  setToolsTab: (toolsTab) => set({ toolsTab }),
  openTool: (toolsTab) => set({ toolsTab, view: "tools" }),
}));
