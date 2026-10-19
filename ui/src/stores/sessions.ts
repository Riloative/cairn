import { create } from "zustand";

export type SessionProtocol = "ssh" | "telnet" | "serial" | "rdp" | "local";
export type SessionState = "connecting" | "connected" | "disconnected" | "error";

export interface SessionTab {
  id: string;
  title: string;
  protocol: SessionProtocol;
  state: SessionState;
  /** Short progress or error text (e.g. "Authenticating as admin"). */
  detail?: string;
  /** Vendor id selecting the highlighting rule set (see terminal/highlight/rulesets). */
  vendor?: string;
  /** The inventory device this tab is connected to, if any. */
  device?: { id: number; vendor: string };
  /** The session is being recorded. */
  recording?: boolean;
  /** Colour scheme chosen for this tab only; unset follows its profile. */
  paletteId?: string;
}

interface SessionsStore {
  tabs: SessionTab[];
  activeId: string | null;
  open: (tab: SessionTab) => void;
  close: (id: string) => void;
  activate: (id: string) => void;
  activateRelative: (offset: number) => void;
  setState: (id: string, state: SessionState, detail?: string) => void;
  setVendor: (id: string, vendor: string) => void;
  setRecording: (id: string, recording: boolean) => void;
  setPalette: (id: string, paletteId: string | undefined) => void;
  /** Move a tab to another position (drag to reorder). */
  move: (id: string, toIndex: number) => void;
}

export const useSessions = create<SessionsStore>((set, get) => ({
  tabs: [],
  activeId: null,
  open: (tab) => set({ tabs: [...get().tabs, tab], activeId: tab.id }),
  close: (id) => {
    const { tabs, activeId } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const next = tabs.filter((t) => t.id !== id);
    // Closing the active tab focuses its right neighbour, else the left one.
    const nextActive =
      activeId === id ? (next[Math.min(idx, next.length - 1)]?.id ?? null) : activeId;
    set({ tabs: next, activeId: nextActive });
  },
  activate: (id) => set({ activeId: id }),
  activateRelative: (offset) => {
    const { tabs, activeId } = get();
    if (tabs.length === 0) return;
    const idx = Math.max(
      0,
      tabs.findIndex((t) => t.id === activeId),
    );
    const next = tabs[(idx + offset + tabs.length) % tabs.length];
    if (next) set({ activeId: next.id });
  },
  setRecording: (id, recording) =>
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, recording } : t)) }),
  move: (id, toIndex) => {
    const tabs = [...get().tabs];
    const from = tabs.findIndex((t) => t.id === id);
    if (from < 0) return;
    const [tab] = tabs.splice(from, 1);
    if (!tab) return;
    tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, tab);
    set({ tabs });
  },
  setPalette: (id, paletteId) =>
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, paletteId } : t)) }),
  setVendor: (id, vendor) =>
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, vendor } : t)) }),
  setState: (id, state, detail) =>
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, state, detail } : t)) }),
}));
