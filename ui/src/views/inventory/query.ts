import type { CustomField, Device, DeviceType, InventorySnapshot } from "@/lib/ipc";
import { DEVICE_TYPE_LABEL } from "./labels";

export type GroupBy = "none" | "building" | "type" | "vendor";

export interface Facets {
  type: DeviceType[];
  vendor: string[];
  /** Building ids as strings; "none" for devices without a building. */
  building: string[];
  tag: string[];
}

export const EMPTY_FACETS: Facets = { type: [], vendor: [], building: [], tag: [] };

/** Human location, most specific last: "HQ · 2nd floor · MDF · R1 U12". */
export function locationLabel(d: Device, s: InventorySnapshot): string {
  const parts: string[] = [];
  const b = s.buildings.find((x) => x.id === d.buildingId);
  const f = s.floors.find((x) => x.id === d.floorId);
  const room = s.rooms.find((x) => x.id === d.roomId);
  const rack = s.racks.find((x) => x.id === d.rackId);
  if (b) parts.push(b.name);
  if (f) parts.push(f.name);
  if (room) parts.push(room.name);
  if (rack) parts.push(d.rackU ? `${rack.name} U${d.rackU}` : rack.name);
  return parts.join(" · ");
}

function customText(v: Device["custom"][string]): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(" ");
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

/** Everything full-text search looks at, lower-cased. */
export function searchText(d: Device, s: InventorySnapshot): string {
  const cred = s.credentials.find((c) => c.id === d.credentialId)?.name ?? "";
  return [
    d.hostname,
    d.mgmtIp,
    DEVICE_TYPE_LABEL[d.deviceType],
    d.vendor,
    d.model,
    d.serial,
    d.firmware,
    d.assetNumber,
    locationLabel(d, s),
    cred,
    d.tags.join(" "),
    d.vlans.join(" "),
    d.notes,
    ...Object.values(d.custom).map(customText),
  ]
    .join("\n")
    .toLowerCase();
}

/** Apply full-text search (all words must match) and facet filters. */
export function filterDevices(s: InventorySnapshot, search: string, facets: Facets): Device[] {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  return s.devices.filter((d) => {
    if (facets.type.length && !facets.type.includes(d.deviceType)) return false;
    if (facets.vendor.length && !facets.vendor.includes(d.vendor)) return false;
    if (facets.building.length && !facets.building.includes(String(d.buildingId ?? "none")))
      return false;
    if (facets.tag.length && !facets.tag.some((t) => d.tags.includes(t))) return false;
    if (!words.length) return true;
    const text = searchText(d, s);
    return words.every((w) => text.includes(w));
  });
}

export function groupKey(d: Device, by: GroupBy, s: InventorySnapshot): string {
  switch (by) {
    case "building":
      return s.buildings.find((b) => b.id === d.buildingId)?.name ?? "No building";
    case "type":
      return DEVICE_TYPE_LABEL[d.deviceType];
    case "vendor":
      return d.vendor;
    case "none":
      return "";
  }
}

export type ListItem<T> =
  { kind: "group"; key: string; count: number; collapsed: boolean } | { kind: "row"; row: T };

/**
 * Turn already-sorted rows into a flat list with group headers. Groups are ordered by
 * name ("No …" groups last); rows keep their order inside a group.
 */
export function groupRows<T>(
  rows: T[],
  keyOf: (row: T) => string,
  by: GroupBy,
  collapsed: ReadonlySet<string>,
): ListItem<T>[] {
  if (by === "none") return rows.map((row) => ({ kind: "row", row }));
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = keyOf(row);
    const list = groups.get(k);
    if (list) list.push(row);
    else groups.set(k, [row]);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const na = a.startsWith("No "),
      nb = b.startsWith("No ");
    if (na !== nb) return na ? 1 : -1;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  });
  const out: ListItem<T>[] = [];
  for (const key of keys) {
    const list = groups.get(key) ?? [];
    const isCollapsed = collapsed.has(key);
    out.push({ kind: "group", key, count: list.length, collapsed: isCollapsed });
    if (!isCollapsed) for (const row of list) out.push({ kind: "row", row });
  }
  return out;
}

/** Value used for sorting and display of a custom field. */
export function customDisplay(field: CustomField, v: Device["custom"][string]): string {
  if (v === null || v === undefined) return "";
  if (field.kind === "boolean") return v ? "Yes" : "No";
  return customText(v);
}

/** Natural sort that keeps IP addresses in numeric order. */
export function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export function compareIp(a: string, b: string): number {
  const v4 = (ip: string) => {
    const p = ip.split(".");
    return p.length === 4 ? p.reduce((n, x) => n * 256 + Number(x), 0) : null;
  };
  const x = v4(a),
    y = v4(b);
  if (x !== null && y !== null) return x - y;
  if (!a) return b ? 1 : 0;
  if (!b) return -1;
  return compareText(a, b);
}
