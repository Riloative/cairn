import type { SortingState, VisibilityState } from "@tanstack/react-table";
import { create } from "zustand";
import { EMPTY_FACETS, type Facets, type GroupBy } from "@/views/inventory/query";

/** Columns shown until the user picks their own. */
export const DEFAULT_COLUMNS: VisibilityState = {
  serial: false,
  firmware: false,
  credential: false,
  interfaces: false,
  vlans: false,
  updatedAt: false,
};

/** The saved part of the devices table (what a saved view stores). */
export interface TableView {
  search: string;
  facets: Facets;
  groupBy: GroupBy;
  sorting: SortingState;
  columns: VisibilityState;
}

export const DEFAULT_VIEW: TableView = {
  search: "",
  facets: EMPTY_FACETS,
  groupBy: "none",
  sorting: [{ id: "hostname", desc: false }],
  columns: DEFAULT_COLUMNS,
};

interface TableStore extends TableView {
  collapsed: string[];
  /** Saved view currently applied (cleared when the table state diverges). */
  activeViewId: number | null;
  set: (patch: Partial<TableView>) => void;
  apply: (view: TableView, id: number | null) => void;
  toggleGroup: (key: string) => void;
}

/** Read a saved view's state defensively (it is stored as opaque JSON). */
export function parseView(state: Record<string, unknown>): TableView {
  const facets = (state.facets ?? {}) as Partial<Facets>;
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const groupBy = ["none", "building", "type", "vendor"].includes(String(state.groupBy))
    ? (state.groupBy as GroupBy)
    : "none";
  return {
    search: typeof state.search === "string" ? state.search : "",
    facets: {
      type: arr(facets.type) as Facets["type"],
      vendor: arr(facets.vendor),
      building: arr(facets.building),
      tag: arr(facets.tag),
    },
    groupBy,
    sorting: Array.isArray(state.sorting) ? (state.sorting as SortingState) : DEFAULT_VIEW.sorting,
    columns:
      state.columns && typeof state.columns === "object"
        ? (state.columns as VisibilityState)
        : DEFAULT_COLUMNS,
  };
}

export const useInventoryTable = create<TableStore>((set, get) => ({
  ...DEFAULT_VIEW,
  collapsed: [],
  activeViewId: null,
  set: (patch) => set({ ...patch, activeViewId: null }),
  apply: (view, id) => set({ ...view, activeViewId: id, collapsed: [] }),
  toggleGroup: (key) => {
    const c = get().collapsed;
    set({ collapsed: c.includes(key) ? c.filter((k) => k !== key) : [...c, key] });
  },
}));

export function currentView(): TableView {
  const { search, facets, groupBy, sorting, columns } = useInventoryTable.getState();
  return { search, facets, groupBy, sorting, columns };
}
