import { create } from "zustand";

/** How the remote desktop is shown in its tab. */
export type RdpScale = "fit" | "actual";

export interface RdpTabUi {
  /** Desktop size in device pixels (0 until connected). */
  width: number;
  height: number;
  scale: RdpScale;
  /** CSS cursor from the server's pointer bitmap. */
  cursor: string;
  /** Clipboard sync allowed by the connection's settings. */
  clipboard: boolean;
  /** macOS: send ⌘ as Ctrl, so ⌘C / ⌘V / ⌘Z work as on the Mac. */
  cmdAsCtrl: boolean;
  fullscreen: boolean;
  /** The desktop size follows the view (no fixed resolution). */
  followView: boolean;
}

interface RdpStore {
  byTab: Record<string, RdpTabUi>;
  init: (tabId: string, ui: Partial<RdpTabUi>) => void;
  patch: (tabId: string, ui: Partial<RdpTabUi>) => void;
  drop: (tabId: string) => void;
}

export const DEFAULT_RDP_UI: RdpTabUi = {
  width: 0,
  height: 0,
  scale: "fit",
  cursor: "default",
  clipboard: true,
  cmdAsCtrl: true,
  fullscreen: false,
  followView: true,
};

export const useRdp = create<RdpStore>((set, get) => ({
  byTab: {},
  init: (tabId, ui) => set({ byTab: { ...get().byTab, [tabId]: { ...DEFAULT_RDP_UI, ...ui } } }),
  patch: (tabId, ui) => {
    const current = get().byTab[tabId];
    if (current) set({ byTab: { ...get().byTab, [tabId]: { ...current, ...ui } } });
  },
  drop: (tabId) =>
    set({ byTab: Object.fromEntries(Object.entries(get().byTab).filter(([id]) => id !== tabId)) }),
}));
