import { create } from "zustand";
import * as ipc from "@/lib/ipc";
import type { ForwardInfo, ForwardPreset, ForwardSpec } from "@/lib/ipc";
import { useNotifications } from "./notifications";

interface ForwardsState {
  active: ForwardInfo[];
  presets: ForwardPreset[] | null;
  /** Tab to preselect in the "new forward" form (from a terminal header). */
  preselectTab: string | null;
  setPreselectTab: (tabId: string | null) => void;
  refresh: () => Promise<void>;
  loadPresets: () => Promise<void>;
  start: (sessionId: string, spec: ForwardSpec) => Promise<ForwardInfo | null>;
  stop: (id: number) => Promise<void>;
  savePreset: (preset: ForwardPreset) => Promise<ForwardPreset | null>;
  deletePreset: (id: number) => Promise<void>;
}

const notifyError = (e: unknown, title: string) =>
  useNotifications.getState().notifyError(e, title);

export const useForwards = create<ForwardsState>((set, get) => ({
  active: [],
  presets: null,
  preselectTab: null,
  setPreselectTab: (preselectTab) => set({ preselectTab }),
  refresh: async () => {
    try {
      set({ active: await ipc.forwardsList() });
    } catch {
      // Locked or not running in Tauri: keep the last list.
    }
  },
  loadPresets: async () => {
    try {
      set({ presets: await ipc.forwardPresetsList() });
    } catch (e) {
      notifyError(e, "Could not load port-forward presets");
    }
  },
  start: async (sessionId, spec) => {
    try {
      const f = await ipc.forwardStart(sessionId, spec);
      await get().refresh();
      return f;
    } catch (e) {
      notifyError(e, "Could not start the port forward");
      return null;
    }
  },
  stop: async (id) => {
    try {
      await ipc.forwardStop(id);
    } catch (e) {
      notifyError(e, "Could not stop the port forward");
    }
    await get().refresh();
  },
  savePreset: async (preset) => {
    try {
      const saved = await ipc.forwardPresetSave(preset);
      await get().loadPresets();
      return saved;
    } catch (e) {
      notifyError(e, "Could not save the preset");
      return null;
    }
  },
  deletePreset: async (id) => {
    try {
      await ipc.forwardPresetDelete(id);
      await get().loadPresets();
    } catch (e) {
      notifyError(e, "Could not delete the preset");
    }
  },
}));
