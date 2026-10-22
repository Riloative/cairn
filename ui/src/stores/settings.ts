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

/**
 * Updates run one after another. Each patch is applied to the settings as returned by
 * the previous save, so two quick changes (say a sidebar toggle while a theme save is in
 * flight) both persist instead of the later one resubmitting stale state over the
 * earlier. A failed update rejects its own caller and does not block the next one.
 */
let queue: Promise<void> = Promise.resolve();

export const useSettings = create<SettingsState>((set, get) => ({
  settings: null,
  load: async () => {
    const settings = await ipc.settingsGet();
    apply(settings);
    set({ settings });
  },
  update: (patch) => {
    const run = queue.then(async () => {
      const current = get().settings;
      if (!current) return;
      const saved = await ipc.settingsUpdate({ ...current, ...patch });
      apply(saved);
      set({ settings: saved });
    });
    queue = run.catch(() => {});
    return run;
  },
  clear: () => set({ settings: null }),
}));
