import { create } from "zustand";
import type { AuditFilter } from "@/lib/ipc";

export type TimeRange = "any" | "24h" | "7d" | "30d" | "custom";

export interface AuditViewFilter {
  range: TimeRange;
  /** `YYYY-MM-DD` (local dates) for the custom range; `to` is inclusive. */
  customFrom: string;
  customTo: string;
  kinds: string[];
  device: string;
  protocol: string;
  text: string;
}

export const EMPTY_AUDIT_FILTER: AuditViewFilter = {
  range: "any",
  customFrom: "",
  customTo: "",
  kinds: [],
  device: "",
  protocol: "",
  text: "",
};

const HOUR = 3_600_000;
const RANGE_MS: Record<Exclude<TimeRange, "any" | "custom">, number> = {
  "24h": 24 * HOUR,
  "7d": 7 * 24 * HOUR,
  "30d": 30 * 24 * HOUR,
};

/** Local midnight of a `YYYY-MM-DD` date, plus `days`. */
function localDay(date: string, days = 0): string | null {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d + days).toISOString();
}

/** The backend filter for the view's filter at time `now`. */
export function toAuditFilter(f: AuditViewFilter, now = Date.now()): AuditFilter {
  let from: string | null = null;
  let to: string | null = null;
  if (f.range === "custom") {
    from = f.customFrom ? localDay(f.customFrom) : null;
    to = f.customTo ? localDay(f.customTo, 1) : null;
  } else if (f.range !== "any") {
    from = new Date(now - RANGE_MS[f.range]).toISOString();
  }
  return {
    from,
    to,
    kinds: f.kinds,
    device: f.device || null,
    protocol: f.protocol || null,
    text: f.text.trim() || null,
  };
}

export function activeFilterCount(f: AuditViewFilter): number {
  return (
    (f.range !== "any" ? 1 : 0) +
    (f.kinds.length > 0 ? 1 : 0) +
    (f.device ? 1 : 0) +
    (f.protocol ? 1 : 0) +
    (f.text.trim() ? 1 : 0)
  );
}

interface AuditViewStore {
  filter: AuditViewFilter;
  set: (patch: Partial<AuditViewFilter>) => void;
  reset: () => void;
}

export const useAuditView = create<AuditViewStore>((set, get) => ({
  filter: EMPTY_AUDIT_FILTER,
  set: (patch) => set({ filter: { ...get().filter, ...patch } }),
  reset: () => set({ filter: EMPTY_AUDIT_FILTER }),
}));
