import type { Device, InventorySnapshot, Link, MapSnapshot, Zone } from "@/lib/ipc";
import { parallelOffset, type Rect } from "./geometry";

/** What the map shows: a site's campus, a building, a floor, or a floor's racks. */
export type MapViewRef =
  | { kind: "campus"; siteId: number }
  | { kind: "building"; id: number }
  | { kind: "floor"; id: number }
  | { kind: "rack"; floorId: number };

export const DEVICE_SIZE = { w: 136, h: 84 };
export const BUILDING_SIZE = { w: 200, h: 112 };

/** Storage key of a view's layout (`campus:1`); rack views have none. */
export function viewKey(v: MapViewRef): string | null {
  switch (v.kind) {
    case "campus":
      return `campus:${v.siteId}`;
    case "building":
      return `building:${v.id}`;
    case "floor":
      return `floor:${v.id}`;
    case "rack":
      return null;
  }
}

export interface NodeModel {
  /** `d:<device>` or `b:<building>`; also the React Flow node id. */
  key: string;
  /** `external`: a peer outside this view, shown dimmed for context. */
  kind: "device" | "building" | "external";
  deviceId?: number;
  buildingId?: number;
  x: number;
  y: number;
  w: number;
  h: number;
  locked: boolean;
  /** Whether a position was stored (unplaced nodes get one from the auto-layout). */
  placed: boolean;
  /** Building view: the floor band the device belongs to (null = no floor). */
  band?: number | null;
}

export interface EdgeModel {
  key: string;
  source: string;
  target: string;
  /** The cable(s) drawn by this edge; several only for aggregated campus edges. */
  links: Link[];
  /** Perpendicular offset among parallel edges of the same pair. */
  offset: number;
}

export interface ViewModel {
  key: string;
  nodes: NodeModel[];
  edges: EdgeModel[];
  zones: Zone[];
}

function owner(
  ref: MapViewRef,
  d: Device,
  inv: InventorySnapshot,
): { key: string; inside: boolean } | null {
  switch (ref.kind) {
    case "campus": {
      if (d.buildingId === null) return { key: `d:${d.id}`, inside: true };
      const b = inv.buildings.find((x) => x.id === d.buildingId);
      return b && b.siteId === ref.siteId ? { key: `b:${b.id}`, inside: true } : null;
    }
    case "building":
      return { key: `d:${d.id}`, inside: d.buildingId === ref.id };
    case "floor":
      return { key: `d:${d.id}`, inside: d.floorId === ref.id };
    case "rack":
      return null;
  }
}

/** Nodes, edges and zones of a view, with stored positions applied. */
export function buildView(ref: MapViewRef, inv: InventorySnapshot, map: MapSnapshot): ViewModel {
  const key = viewKey(ref) ?? "";
  const stored = new Map(map.positions.filter((p) => p.view === key).map((p) => [p.node, p]));
  const devices = new Map(inv.devices.map((d) => [d.id, d]));
  const nodes = new Map<string, NodeModel>();

  const place = (n: Omit<NodeModel, "x" | "y" | "locked" | "placed">): NodeModel => {
    const p = stored.get(n.key);
    return {
      ...n,
      x: p?.x ?? 0,
      y: p?.y ?? 0,
      locked: p?.locked ?? false,
      placed: p !== undefined,
    };
  };

  if (ref.kind === "campus") {
    for (const b of inv.buildings.filter((x) => x.siteId === ref.siteId))
      nodes.set(
        `b:${b.id}`,
        place({ key: `b:${b.id}`, kind: "building", buildingId: b.id, ...BUILDING_SIZE }),
      );
    for (const d of inv.devices.filter((x) => x.buildingId === null))
      nodes.set(
        `d:${d.id}`,
        place({ key: `d:${d.id}`, kind: "device", deviceId: d.id, ...DEVICE_SIZE }),
      );
  } else if (ref.kind !== "rack") {
    for (const d of inv.devices) {
      const o = owner(ref, d, inv);
      if (o?.inside)
        nodes.set(
          o.key,
          place({
            key: o.key,
            kind: "device",
            deviceId: d.id,
            ...DEVICE_SIZE,
            band: ref.kind === "building" ? d.floorId : undefined,
          }),
        );
    }
  }

  // Links between nodes; peers outside a building/floor view appear as external nodes.
  const raw: { source: string; target: string; link: Link }[] = [];
  for (const link of map.links) {
    const a = devices.get(link.aDeviceId);
    const b = devices.get(link.bDeviceId);
    if (!a || !b) continue;
    const oa = owner(ref, a, inv);
    const ob = owner(ref, b, inv);
    if (!oa || !ob || oa.key === ob.key) continue;
    if (!oa.inside && !ob.inside) continue;
    for (const [o, d] of [
      [oa, a],
      [ob, b],
    ] as const) {
      if (!o.inside && !nodes.has(o.key))
        nodes.set(o.key, place({ key: o.key, kind: "external", deviceId: d.id, ...DEVICE_SIZE }));
    }
    raw.push({ source: oa.key, target: ob.key, link });
  }

  const pairKey = (s: string, t: string) => (s < t ? `${s}|${t}` : `${t}|${s}`);
  const edges: EdgeModel[] = [];
  if (ref.kind === "campus") {
    // One edge per pair of buildings/devices, carrying all its cables.
    const byPair = new Map<string, EdgeModel>();
    for (const r of raw) {
      const k = pairKey(r.source, r.target);
      const e = byPair.get(k);
      if (e) e.links.push(r.link);
      else
        byPair.set(k, {
          key: `e:${k}`,
          source: r.source,
          target: r.target,
          links: [r.link],
          offset: 0,
        });
    }
    edges.push(...byPair.values());
  } else {
    const groups = new Map<string, typeof raw>();
    for (const r of raw) {
      const k = pairKey(r.source, r.target);
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    for (const group of groups.values()) {
      // LAG members next to each other, then by id, so bundles stay together.
      group.sort((x, y) => x.link.lag.localeCompare(y.link.lag) || x.link.id - y.link.id);
      group.forEach((r, i) =>
        edges.push({
          key: `l:${r.link.id}`,
          source: r.source,
          target: r.target,
          links: [r.link],
          offset: parallelOffset(i, group.length),
        }),
      );
    }
  }

  return {
    key,
    nodes: [...nodes.values()],
    edges,
    zones: map.zones.filter((z) => z.view === key),
  };
}

/**
 * LAG bundles among a view's single-link edges: the first member's key → all member
 * keys, in drawing order (members of one pair and LAG name).
 */
export function lagBundles(edges: readonly EdgeModel[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const e of edges) {
    const lag = e.links.length === 1 ? (e.links[0]?.lag ?? "") : "";
    if (!lag) continue;
    const k = `${[e.source, e.target].sort().join("|")}|${lag}`;
    groups.set(k, [...(groups.get(k) ?? []), e.key]);
  }
  const out = new Map<string, string[]>();
  for (const keys of groups.values()) if (keys.length > 1) out.set(keys[0] as string, keys);
  return out;
}

/** Size of a device's icon tile, drawn centered at the top of its node box. */
export const DEVICE_TILE = 44;

/** The icon tile of a device node box: links leave devices sideways from the tile. */
export function tileRect(r: Rect): Rect {
  return { x: r.x + (r.w - DEVICE_TILE) / 2, y: r.y + 4, w: DEVICE_TILE, h: DEVICE_TILE };
}

export const rectOf = (n: Pick<NodeModel, "x" | "y" | "w" | "h">): Rect => ({
  x: n.x,
  y: n.y,
  w: n.w,
  h: n.h,
});

/** Place unplaced nodes on a grid below the placed ones (new devices). */
export function placeNew(nodes: NodeModel[], grid = 16): NodeModel[] {
  const placed = nodes.filter((n) => n.placed);
  const bottom = placed.length ? Math.max(...placed.map((n) => n.y + n.h)) + 48 : 0;
  const left = placed.length ? Math.min(...placed.map((n) => n.x)) : 0;
  let i = 0;
  const perRow = 6;
  return nodes.map((n) => {
    if (n.placed) return n;
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    i += 1;
    const snap = (v: number) => Math.round(v / grid) * grid;
    return { ...n, x: snap(left + col * (n.w + 48)), y: snap(bottom + row * (n.h + 64)) };
  });
}

/** Breadcrumb trail for a view. */
export function breadcrumbs(
  ref: MapViewRef,
  inv: InventorySnapshot,
): { label: string; view: MapViewRef }[] {
  const campus = (siteId: number): { label: string; view: MapViewRef } => ({
    label: inv.sites.find((s) => s.id === siteId)?.name ?? "Campus",
    view: { kind: "campus", siteId },
  });
  const building = (id: number) => {
    const b = inv.buildings.find((x) => x.id === id);
    return b
      ? [campus(b.siteId), { label: b.name, view: { kind: "building", id } as MapViewRef }]
      : [];
  };
  const floor = (id: number) => {
    const f = inv.floors.find((x) => x.id === id);
    return f
      ? [...building(f.buildingId), { label: f.name, view: { kind: "floor", id } as MapViewRef }]
      : [];
  };
  switch (ref.kind) {
    case "campus":
      return [campus(ref.siteId)];
    case "building":
      return building(ref.id);
    case "floor":
      return floor(ref.id);
    case "rack":
      return [...floor(ref.floorId), { label: "Racks", view: ref }];
  }
}
