import { create } from "zustand";
import * as ipc from "@/lib/ipc";
import type { TerminalPrefs, TerminalProfile } from "@/lib/ipc";
import type { Palette } from "@/terminal/palette";

/** Used until the encrypted preferences load (and in tests). Mirrors the Rust default. */
export const DEFAULT_PROFILE: TerminalProfile = {
  id: "default",
  name: "Default",
  fontFamily: "JetBrains Mono Variable",
  fontSize: 13,
  lineHeight: 1.2,
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 10_000,
  paletteId: null,
  opacity: 1,
  bell: "visual",
  copyOnSelect: false,
  pasteLineDelayMs: 0,
  shell: null,
};

export const DEFAULT_PRIVILEGED_PATTERNS = [
  String.raw`^[\w.\-/()]+(\([\w.\-]+\))?#\s?$`,
  String.raw`^root@[\w.\-]+[%#]\s?$`,
  String.raw`^root@[\w.\-]+:[^\s]*#\s?$`,
  String.raw`^\[root@[^\]]+\]#\s?$`,
  String.raw`^\[[\w.\-/]+\]\s?$`,
];

export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
  profiles: [DEFAULT_PROFILE],
  defaultProfileId: "default",
  customPalettes: [],
  privilegedPromptPatterns: DEFAULT_PRIVILEGED_PATTERNS,
  confirmMultilinePaste: true,
  highlightEnabled: true,
  highlightSets: [],
};

interface TerminalPrefsState {
  prefs: TerminalPrefs;
  loaded: boolean;
  load: () => Promise<void>;
  update: (patch: Partial<TerminalPrefs>) => Promise<void>;
}

export const useTerminalPrefs = create<TerminalPrefsState>((set, get) => ({
  prefs: DEFAULT_TERMINAL_PREFS,
  loaded: false,
  load: async () => set({ prefs: await ipc.terminalPrefsGet(), loaded: true }),
  update: async (patch) => {
    const saved = await ipc.terminalPrefsUpdate({ ...get().prefs, ...patch });
    set({ prefs: saved });
  },
}));

export function profileById(prefs: TerminalPrefs, id?: string | null): TerminalProfile {
  return (
    prefs.profiles.find((p) => p.id === (id ?? prefs.defaultProfileId)) ??
    prefs.profiles[0] ??
    DEFAULT_PROFILE
  );
}

export function customPalettes(prefs: TerminalPrefs): Palette[] {
  return prefs.customPalettes as unknown as Palette[];
}
