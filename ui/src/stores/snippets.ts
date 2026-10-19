import { create } from "zustand";
import * as ipc from "@/lib/ipc";
import type { Snippet } from "@/lib/ipc";
import { useNotifications } from "./notifications";

const BAR_KEY = "cairn.snippetBar";

function readBar(): boolean {
  try {
    return localStorage.getItem(BAR_KEY) === "1";
  } catch {
    return false;
  }
}

interface SnippetsState {
  list: Snippet[] | null;
  load: () => Promise<void>;
  /** Saves and refreshes; resolves with the stored snippet, or null on error. */
  save: (snippet: Snippet) => Promise<Snippet | null>;
  remove: (snippet: Snippet) => Promise<void>;
  clear: () => void;
  managerOpen: boolean;
  /** Snippet to select when the manager opens (0 = a new one). */
  managerSelect: number | null;
  openManager: (select?: number | null) => void;
  closeManager: () => void;
  barVisible: boolean;
  setBarVisible: (visible: boolean) => void;
  /** A snippet waiting for its variables before being inserted into `tabId`. */
  pending: { snippet: Snippet; tabId: string } | null;
  setPending: (p: { snippet: Snippet; tabId: string } | null) => void;
}

export const useSnippets = create<SnippetsState>((set, get) => ({
  list: null,
  load: async () => {
    try {
      set({ list: await ipc.snippetsList() });
    } catch (e) {
      useNotifications.getState().notifyError(e, "Could not load snippets");
    }
  },
  save: async (snippet) => {
    try {
      const saved = await ipc.snippetSave(snippet);
      await get().load();
      return saved;
    } catch (e) {
      useNotifications.getState().notifyError(e, "Could not save the snippet");
      return null;
    }
  },
  remove: async (snippet) => {
    try {
      await ipc.snippetDelete(snippet.id);
      await get().load();
    } catch (e) {
      useNotifications.getState().notifyError(e, "Could not delete the snippet");
    }
  },
  clear: () => set({ list: null, pending: null, managerOpen: false }),
  managerOpen: false,
  managerSelect: null,
  openManager: (select = null) => set({ managerOpen: true, managerSelect: select }),
  closeManager: () => set({ managerOpen: false }),
  barVisible: readBar(),
  setBarVisible: (barVisible) => {
    try {
      localStorage.setItem(BAR_KEY, barVisible ? "1" : "0");
    } catch {
      // Not persisted (private storage); the toggle still works for this run.
    }
    set({ barVisible });
  },
  pending: null,
  setPending: (pending) => set({ pending }),
}));
