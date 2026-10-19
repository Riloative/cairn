import type { Device, InventorySnapshot } from "@/lib/ipc";
import type { MapViewRef } from "@/map/model";

/** The most specific map view that shows a device. */
export function locate(d: Device, inv: InventorySnapshot): MapViewRef {
  if (d.floorId !== null) return { kind: "floor", id: d.floorId };
  if (d.buildingId !== null) return { kind: "building", id: d.buildingId };
  return { kind: "campus", siteId: inv.sites[0]?.id ?? 1 };
}

/** "HQ · 2nd" for a device outside the current view. */
export function whereLabel(d: Device, inv: InventorySnapshot): string {
  const b = inv.buildings.find((x) => x.id === d.buildingId);
  const f = inv.floors.find((x) => x.id === d.floorId);
  return [b?.name, f?.name].filter(Boolean).join(" · ") || "no location";
}
