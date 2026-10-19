import { create } from "zustand";

/** Delays between automatic reconnect attempts, in seconds. */
export const BACKOFF_SECS = [2, 4, 8, 16, 30, 30] as const;

export interface ReconnectState {
  /** Attempts made so far in this outage. */
  attempt: number;
  /** When the next automatic attempt fires (ms epoch); null when not scheduled. */
  nextAt: number | null;
  /** The last error, shown in the overlay. */
  message: string;
}

interface Store {
  byTab: Record<string, ReconnectState>;
  set: (tabId: string, s: ReconnectState) => void;
  clear: (tabId: string) => void;
}

export const useReconnect = create<Store>((set, get) => ({
  byTab: {},
  set: (tabId, s) => set({ byTab: { ...get().byTab, [tabId]: s } }),
  clear: (tabId) =>
    set({ byTab: Object.fromEntries(Object.entries(get().byTab).filter(([k]) => k !== tabId)) }),
}));

/** Delay before attempt number `attempt` (0-based), or null when giving up. */
export function backoffDelay(attempt: number): number | null {
  const s = BACKOFF_SECS[attempt];
  return s === undefined ? null : s * 1000;
}
