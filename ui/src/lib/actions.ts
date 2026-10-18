import { create } from "zustand";
import type { Shortcut } from "./shortcuts";

/**
 * Global action registry. Every command the user can run — from the palette, a shortcut or
 * a menu — is an Action, so the palette, the shortcut handler and the shortcuts list in
 * Settings always agree.
 */
export interface Action {
  id: string;
  title: string;
  /** Palette section, e.g. "Navigation". */
  group: string;
  /** Extra search terms. */
  keywords?: string[];
  shortcut?: Shortcut;
  /** Hidden from the palette and shortcuts when this returns false. */
  enabled?: () => boolean;
  run: () => unknown;
}

interface ActionsState {
  actions: Map<string, Action>;
  /** Register actions; returns a function that unregisters them. */
  register: (actions: Action[]) => () => void;
}

export const useActions = create<ActionsState>((set, get) => ({
  actions: new Map(),
  register: (actions) => {
    const next = new Map(get().actions);
    for (const a of actions) next.set(a.id, a);
    set({ actions: next });
    return () => {
      const after = new Map(get().actions);
      for (const a of actions) if (after.get(a.id) === a) after.delete(a.id);
      set({ actions: after });
    };
  },
}));

export function availableActions(actions: Map<string, Action>): Action[] {
  return [...actions.values()].filter((a) => a.enabled?.() ?? true);
}
