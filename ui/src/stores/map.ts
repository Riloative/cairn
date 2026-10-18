import { create } from "zustand";
import * as ipc from "@/lib/ipc";
import type { MapPosition, MapPrefs, MapSnapshot, Zone } from "@/lib/ipc";
import type { MapViewRef } from "@/map/model";
import { useNotifications } from "./notifications";

/** One undoable layout edit. Link and inventory changes are not part of map undo. */
export type HistoryEntry =
  | { kind: "positions"; before: MapPosition[]; after: MapPosition[] }
  | { kind: "zone"; before: Zone | null; after: Zone | null }
  | { kind: "batch"; entries: HistoryEntry[] };

const HISTORY_LIMIT = 100;

interface MapState {
  data: MapSnapshot | null;
  error: string | null;
  /** Current view; null until chosen (the first site's campus). */
  view: MapViewRef | null;
  /** Session-wide "lock layout" toggle (per-node locks are stored with positions). */
  layoutLocked: boolean;
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** Object URLs of loaded floor-plan images, by floor id. */
  planUrls: Record<number, string>;
  load: () => Promise<void>;
  clear: () => void;
  setView: (view: MapViewRef) => void;
  setLayoutLocked: (locked: boolean) => void;
  /** Store positions optimistically; with `before`, the change can be undone. */
  savePositions: (after: MapPosition[], before?: MapPosition[]) => Promise<void>;
  saveZone: (zone: Zone, record?: boolean) => Promise<Zone | undefined>;
  deleteZone: (zone: Zone, record?: boolean) => Promise<void>;
  /** Record an already-applied edit (e.g. a zone drag with its contents). */
  pushHistory: (entry: HistoryEntry) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  setPrefs: (prefs: MapPrefs) => Promise<void>;
  /** Object URL of a floor's plan image (loaded once). */
  planUrl: (floorId: number, mime: string) => Promise<string>;
  dropPlanUrl: (floorId: number) => void;
}

function report(e: unknown, title: string) {
  useNotifications.getState().notifyError(e, title);
}

function mergePositions(current: MapPosition[], changes: MapPosition[]): MapPosition[] {
  const key = (p: MapPosition) => `${p.view}|${p.node}`;
  const map = new Map(current.map((p) => [key(p), p]));
  for (const p of changes) map.set(key(p), p);
  return [...map.values()];
}

export const useMap = create<MapState>((set, get) => {
  const record = (entry: HistoryEntry) =>
    set({ past: [...get().past, entry].slice(-HISTORY_LIMIT), future: [] });

  const patch = (fn: (d: MapSnapshot) => MapSnapshot) => {
    const d = get().data;
    if (d) set({ data: fn(d) });
  };

  /** Apply one direction of a history entry without recording it. */
  async function apply(entry: HistoryEntry, direction: "undo" | "redo"): Promise<HistoryEntry> {
    if (entry.kind === "batch") {
      const order = direction === "undo" ? [...entry.entries].reverse() : entry.entries;
      const done: HistoryEntry[] = [];
      for (const e of order) done.push(await apply(e, direction));
      return { kind: "batch", entries: direction === "undo" ? done.reverse() : done };
    }
    if (entry.kind === "positions") {
      await get().savePositions(direction === "undo" ? entry.before : entry.after);
      return entry;
    }
    const target = direction === "undo" ? entry.before : entry.after;
    const current = direction === "undo" ? entry.after : entry.before;
    if (target === null) {
      if (current) await get().deleteZone(current, false);
      return entry;
    }
    const saved = await get().saveZone(target.id && current ? target : { ...target, id: 0 }, false);
    if (!saved) return entry;
    // A re-created zone gets a new id; keep the history pointing at it.
    return direction === "undo" ? { ...entry, before: saved } : { ...entry, after: saved };
  }

  return {
    data: null,
    error: null,
    view: null,
    layoutLocked: false,
    past: [],
    future: [],
    planUrls: {},
    load: async () => {
      try {
        set({ data: await ipc.mapSnapshot(), error: null });
      } catch (e) {
        set({ error: ipc.CommandError.from(e).message });
      }
    },
    clear: () => {
      for (const url of Object.values(get().planUrls)) URL.revokeObjectURL(url);
      set({ data: null, error: null, past: [], future: [], planUrls: {} });
    },
    setView: (view) => set({ view }),
    setLayoutLocked: (layoutLocked) => set({ layoutLocked }),
    savePositions: async (after, before) => {
      if (after.length === 0) return;
      patch((d) => ({ ...d, positions: mergePositions(d.positions, after) }));
      if (before) record({ kind: "positions", before, after });
      try {
        await ipc.mapPositionsSave(after);
      } catch (e) {
        report(e, "Could not save the layout");
        await get().load();
      }
    },
    saveZone: async (zone, rec = true) => {
      const before = get().data?.zones.find((z) => z.id === zone.id) ?? null;
      try {
        const saved = await ipc.zoneSave(zone);
        patch((d) => ({ ...d, zones: [...d.zones.filter((z) => z.id !== saved.id), saved] }));
        if (rec) record({ kind: "zone", before, after: saved });
        return saved;
      } catch (e) {
        report(e, "Could not save the zone");
        return undefined;
      }
    },
    deleteZone: async (zone, rec = true) => {
      try {
        await ipc.zoneDelete(zone.id);
        patch((d) => ({ ...d, zones: d.zones.filter((z) => z.id !== zone.id) }));
        if (rec) record({ kind: "zone", before: zone, after: null });
      } catch (e) {
        report(e, "Could not delete the zone");
      }
    },
    pushHistory: (entry) => record(entry),
    undo: async () => {
      const entry = get().past.at(-1);
      if (!entry) return;
      set({ past: get().past.slice(0, -1) });
      const updated = await apply(entry, "undo");
      set({ future: [updated, ...get().future] });
    },
    redo: async () => {
      const entry = get().future[0];
      if (!entry) return;
      set({ future: get().future.slice(1) });
      const updated = await apply(entry, "redo");
      set({ past: [...get().past, updated] });
    },
    setPrefs: async (prefs) => {
      patch((d) => ({ ...d, prefs }));
      try {
        const saved = await ipc.mapPrefsUpdate(prefs);
        patch((d) => ({ ...d, prefs: saved }));
      } catch (e) {
        report(e, "Could not save map settings");
        await get().load();
      }
    },
    planUrl: async (floorId, mime) => {
      const cached = get().planUrls[floorId];
      if (cached) return cached;
      const bytes = await ipc.floorPlanImage(floorId);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
      set({ planUrls: { ...get().planUrls, [floorId]: url } });
      return url;
    },
    dropPlanUrl: (floorId) => {
      const url = get().planUrls[floorId];
      if (url) URL.revokeObjectURL(url);
      set({
        planUrls: Object.fromEntries(
          Object.entries(get().planUrls).filter(([k]) => Number(k) !== floorId),
        ),
      });
    },
  };
});
