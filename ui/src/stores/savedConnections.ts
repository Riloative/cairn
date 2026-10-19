import { create } from "zustand";
import * as ipc from "@/lib/ipc";
import type { SavedConnection } from "@/lib/ipc";
import { useNotifications } from "./notifications";

interface SavedConnectionsState {
  list: SavedConnection[] | null;
  load: () => Promise<void>;
  /** Saves and refreshes; resolves with the stored connection, or null on error. */
  save: (connection: SavedConnection) => Promise<SavedConnection | null>;
  remove: (connection: SavedConnection) => Promise<void>;
  /** Move a connection to the top of the list after it was opened. */
  markUsed: (id: number) => void;
  clear: () => void;
}

export const useSavedConnections = create<SavedConnectionsState>((set, get) => ({
  list: null,
  load: async () => {
    try {
      set({ list: await ipc.savedConnectionsList() });
    } catch (e) {
      useNotifications.getState().notifyError(e, "Could not load saved connections");
    }
  },
  save: async (connection) => {
    try {
      const saved = await ipc.savedConnectionSave(connection);
      await get().load();
      return saved;
    } catch (e) {
      useNotifications.getState().notifyError(e, "Could not save the connection");
      return null;
    }
  },
  remove: async (connection) => {
    try {
      await ipc.savedConnectionDelete(connection.id);
      await get().load();
    } catch (e) {
      useNotifications.getState().notifyError(e, `Could not delete ${connection.name}`);
    }
  },
  markUsed: (id) => {
    ipc
      .savedConnectionUsed(id)
      .then(() => get().load())
      .catch(() => {
        // Ordering only; nothing to report.
      });
  },
  clear: () => set({ list: null }),
}));
