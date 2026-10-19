import { create } from "zustand";
import type { Link, Zone } from "@/lib/ipc";
import type { ViewModel } from "@/map/model";
import type { MapNode } from "./types";
import { useMap } from "@/stores/map";

/** The link dialog: a new link between two devices, or an existing link. */
export type LinkDialogState =
  { mode: "new"; aDeviceId: number; bDeviceId: number } | { mode: "edit"; link: Link } | null;

/** What the export dialog reads from the live canvas. */
export interface CanvasApi {
  nodes: () => MapNode[];
  selection: () => string[];
  model: ViewModel;
}

interface MapUiState {
  canvas: CanvasApi | null;
  setCanvas: (c: CanvasApi | null) => void;
  linkDialog: LinkDialogState;
  zoneDialog: Zone | null;
  /** Device to center once the view shows it (search across views). */
  focus: number | null;
  exportOpen: boolean;
  planOpen: boolean;
  /** Auto-layout requested from the toolbar; the canvas runs it and clears it. */
  layoutRequest: "all" | "selection" | null;
  setLinkDialog: (s: LinkDialogState) => void;
  setZoneDialog: (z: Zone | null) => void;
  setFocus: (deviceId: number | null) => void;
  setExportOpen: (open: boolean) => void;
  setPlanOpen: (open: boolean) => void;
  requestLayout: (scope: "all" | "selection" | null) => void;
  /** Lock or unlock a node's position in the current view. */
  setNodeLocked: (node: string, locked: boolean) => void;
  /** Close dialogs and drop pending requests (vault lock). */
  reset: () => void;
  resizeZone: (
    zone: Zone,
    rect: { x: number; y: number; width: number; height: number },
  ) => Promise<void>;
}

export const useMapUi = create<MapUiState>((set, get) => ({
  canvas: null,
  setCanvas: (canvas) => set({ canvas }),
  linkDialog: null,
  zoneDialog: null,
  focus: null,
  exportOpen: false,
  planOpen: false,
  layoutRequest: null,
  requestLayout: (layoutRequest) => set({ layoutRequest }),
  setLinkDialog: (linkDialog) => set({ linkDialog }),
  setZoneDialog: (zoneDialog) => set({ zoneDialog }),
  setFocus: (focus) => set({ focus }),
  setExportOpen: (exportOpen) => set({ exportOpen }),
  setPlanOpen: (planOpen) => set({ planOpen }),
  setNodeLocked: (node, locked) => {
    const { data, savePositions } = useMap.getState();
    const key = get().canvas?.model.key;
    const current = data?.positions.find((p) => p.view === key && p.node === node);
    if (!key || !current) return;
    void savePositions([{ ...current, locked }], [current]);
  },
  reset: () =>
    set({
      linkDialog: null,
      zoneDialog: null,
      focus: null,
      exportOpen: false,
      planOpen: false,
      layoutRequest: null,
    }),
  resizeZone: async (zone, rect) => {
    await useMap.getState().saveZone({ ...zone, ...rect });
  },
}));
