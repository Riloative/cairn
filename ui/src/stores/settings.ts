import { create } from "zustand";
import * as ipc from "@/lib/ipc";
import type { Settings } from "@/lib/ipc";
import { applyTheme } from "@/lib/theme";

interface SettingsState {
  settings: Settings | null;
  load: () => Promise<void>;
  /** Save a partial change. The backend validates and audits it. */
  update: (patch: Partial<Settings>) => Promise<void>;
  clear: () => void;
}

function apply(s: Settings) {
  applyTheme({
    theme: s.theme,
    systemDarkTheme: s.systemDarkTheme,
    systemLightTheme: s.systemLightTheme,
  });
  document.documentElement.dataset.reduceMotion = String(s.reduceMotion);
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: null,
  load: async () => {
    const settings = await ipc.settingsGet();
    apply(settings);
    set({ settings });
  },
  update: async (patch) => {
    const current = get().settings;
    if (!current) return;
    const saved = await ipc.settingsUpdate({ ...current, ...patch });
    apply(saved);
    set({ settings: saved });
  },
  clear: () => set({ settings: null }),
}));
