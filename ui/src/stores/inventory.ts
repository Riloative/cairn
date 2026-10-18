import { create } from "zustand";
import * as ipc from "@/lib/ipc";
import type { InventorySnapshot } from "@/lib/ipc";

export type InventorySection = "devices" | "locations" | "vlans" | "credentials" | "fields";

/** What the device side sheet shows. */
export type DeviceSheet =
  | { mode: "view"; deviceId: number; tab?: "overview" | "interfaces" }
  | { mode: "edit"; deviceId: number }
  | { mode: "new" }
  | null;

interface InventoryState {
  snapshot: InventorySnapshot | null;
  error: string | null;
  section: InventorySection;
  sheet: DeviceSheet;
  /** Load (or reload after a change) the whole inventory. */
  load: () => Promise<void>;
  clear: () => void;
  setSection: (section: InventorySection) => void;
  setSheet: (sheet: DeviceSheet) => void;
}

export const useInventory = create<InventoryState>((set) => ({
  snapshot: null,
  error: null,
  section: "devices",
  sheet: null,
  load: async () => {
    try {
      set({ snapshot: await ipc.inventorySnapshot(), error: null });
    } catch (e) {
      set({ error: ipc.CommandError.from(e).message });
    }
  },
  clear: () => set({ snapshot: null, error: null, sheet: null }),
  setSection: (section) => set({ section }),
  setSheet: (sheet) => set({ sheet }),
}));
