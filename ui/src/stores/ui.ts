import { create } from "zustand";
import type { SavedConnection } from "@/lib/ipc";
import { useMapUi } from "@/views/map/mapUi";
import { useDataDialog } from "./backupUi";
import { useBroadcast } from "./broadcast";
import { useConfirm } from "./confirm";
import { useInventory } from "./inventory";
import { useMap } from "./map";
import { usePrompts } from "./prompts";
import { useSavedConnections } from "./savedConnections";
import { useSettings } from "./settings";
import { useSnippets } from "./snippets";
import { useTerminalUi } from "./terminalUi";

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
  /** The saved connection loaded into the connect dialog, if any. */
  editingSaved: SavedConnection | null;
  /** Open the connect dialog filled with a saved connection, to edit or connect. */
  editSaved: (saved: SavedConnection) => void;
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
  setQuickConnectOpen: (quickConnectOpen) =>
    set(quickConnectOpen ? { quickConnectOpen } : { quickConnectOpen, editingSaved: null }),
  setConnectProtocol: (connectProtocol) => set({ connectProtocol }),
  openConnect: (connectProtocol) =>
    set({ connectProtocol, quickConnectOpen: true, editingSaved: null }),
  editingSaved: null,
  editSaved: (editingSaved) =>
    set({ editingSaved, connectProtocol: editingSaved.protocol, quickConnectOpen: true }),
  setView: (view) => set({ view }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setNotificationsOpen: (notificationsOpen) => set({ notificationsOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  toolsTab: "tftp",
  setToolsTab: (toolsTab) => set({ toolsTab }),
  openTool: (toolsTab) => set({ toolsTab, view: "tools" }),
}));

/**
 * Forget everything the unlocked UI held: close dialogs and overlays, settle pending
 * prompts and pastes, drop cached vault data. Called when the vault locks, whether by the
 * user (`vault.lock`) or by the backend (idle, sleep), so nothing reopens after unlock
 * and nothing keeps waiting on an answer the locked backend will never see.
 */
export function resetOnLock() {
  useUi.setState({
    paletteOpen: false,
    notificationsOpen: false,
    shortcutsOpen: false,
    quickConnectOpen: false,
    editingSaved: null,
  });
  useTerminalUi.getState().reset();
  usePrompts.getState().cancelAll();
  useConfirm.getState().answer(false);
  useBroadcast.getState().setPickerOpen(false);
  useDataDialog.getState().set(null);
  useSettings.getState().clear();
  useInventory.getState().clear();
  useMap.getState().clear();
  useMapUi.getState().reset();
  useSnippets.getState().clear();
  useSavedConnections.getState().clear();
}
