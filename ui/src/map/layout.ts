import type { ELK as Elk } from "elkjs/lib/elk-api";
import type { Device, InventorySnapshot } from "@/lib/ipc";
import type { EdgeModel, NodeModel } from "./model";

/**
 * Layer of a node in the hierarchical layout: edge security on top, then routers,
 * core → distribution → access switching (from tags), then servers and endpoints.
 */
export function rank(n: NodeModel, inv: InventorySnapshot): number {
  // Campus: WAN routers and firewalls outside buildings sit above the buildings.
  if (n.kind === "building") return 2;
  const d = inv.devices.find((x) => x.id === n.deviceId);
  if (!d) return 4;
  return deviceRank(d);
}

export function deviceRank(d: Device): number {
  const tags = d.tags.map((t) => t.toLowerCase());
  switch (d.deviceType) {
    case "firewall":
      return 0;
    case "router":
      return 1;
    case "switch":
      if (tags.includes("core")) return 2;
      if (tags.includes("distribution") || tags.includes("dist")) return 3;
      if (tags.includes("access")) return 4;
      return 3;
    case "wireless-controller":
      return 3;
    case "server":
    case "storage":
    case "hypervisor":
      return 5;
    case "access-point":
    case "camera":
    case "ip-phone":
      return 6;
    default:
      return 5;
  }
}

let elkInstance: Promise<Elk> | null = null;

/**
 * ELK in a Web Worker, so laying out a large view never freezes the window. Tests
 * (no Worker in jsdom) use the bundled, synchronous build.
 */
function elk(): Promise<Elk> {
  elkInstance ??=
    typeof Worker === "undefined"
      ? import("elkjs/lib/elk.bundled.js").then((m) => new m.default())
      : Promise.all([
          import("elkjs/lib/elk-api.js"),
          import("elkjs/lib/elk-worker.min.js?url"),
        ]).then(([api, worker]) => new api.default({ workerUrl: worker.default }));
  return elkInstance;
}

/**
 * Layered (top-down) layout of `nodes` with orthogonal routing in mind. Returns new
 * top-left positions, translated so the result starts at `origin`, snapped to `grid`.
 */
export async function autoLayout(
  nodes: readonly NodeModel[],
  edges: readonly EdgeModel[],
  layerOf: (n: NodeModel) => number,
  origin: { x: number; y: number },
  grid: number,
): Promise<Map<string, { x: number; y: number }>> {
  const layer = new Map(nodes.map((n) => [n.key, layerOf(n)]));
  // Edges point down the hierarchy; edges within one layer (a core pair, stacked
  // access switches) are left out so those nodes share a row instead of stacking.
  const layered = edges.flatMap((e) => {
    const ls = layer.get(e.source);
    const lt = layer.get(e.target);
    if (ls === undefined || lt === undefined || ls === lt) return [];
    const [from, to] = ls < lt ? [e.source, e.target] : [e.target, e.source];
    return [{ id: e.key, sources: [from], targets: [to] }];
  });
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "80",
      "elk.layered.spacing.nodeNodeBetweenLayers": "88",
      // Network simplex gives the tidiest rows but grows steeply; above ~80 nodes
      // Brandes-Koepf is several times faster (300 nodes: 4.8 s -> 1.4 s).
      "elk.layered.nodePlacement.strategy": nodes.length > 80 ? "BRANDES_KOEPF" : "NETWORK_SIMPLEX",
      "elk.partitioning.activate": "true",
      // One graph, so each partition is one row across unconnected parts too.
      "elk.separateConnectedComponents": "false",
    },
    children: nodes.map((n) => ({
      id: n.key,
      width: n.w,
      height: n.h,
      layoutOptions: { "elk.partitioning.partition": String(layer.get(n.key)) },
    })),
    edges: layered,
  };
  const out = await (await elk()).layout(graph);
  const raw = new Map<string, { x: number; y: number }>();
  for (const c of out.children ?? []) raw.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  const wrapped = wrapRows(nodes, raw, layer);
  const snap = (v: number) => Math.round(v / grid) * grid;
  const result = new Map<string, { x: number; y: number }>();
  for (const [id, p] of wrapped)
    result.set(id, { x: snap(origin.x + p.x), y: snap(origin.y + p.y) });
  return result;
}

/** Longest row a layer keeps before it wraps (an access layer of 60 switches would
 * otherwise be one strip, unreadable when the view is zoomed to fit). */
export const MAX_ROW = 12;
const GAP_X = 80;
const GAP_Y = 64;

/**
 * Wrap layers wider than `maxRow` nodes into several rows, keeping the left-to-right
 * order ELK chose, and push the layers below down to make room.
 */
export function wrapRows(
  nodes: readonly Pick<NodeModel, "key" | "w" | "h">[],
  pos: ReadonlyMap<string, { x: number; y: number }>,
  layerOf: ReadonlyMap<string, number>,
  maxRow = MAX_ROW,
): Map<string, { x: number; y: number }> {
  const layers = new Map<number, Pick<NodeModel, "key" | "w" | "h">[]>();
  for (const n of nodes) {
    if (!pos.has(n.key)) continue;
    const l = layerOf.get(n.key) ?? 0;
    layers.set(l, [...(layers.get(l) ?? []), n]);
  }
  const at = (n: { key: string }) => pos.get(n.key) ?? { x: 0, y: 0 };
  const top = (members: { key: string }[]) => Math.min(...members.map((n) => at(n).y));
  const out = new Map<string, { x: number; y: number }>();
  let shift = 0;
  for (const members of [...layers.values()].sort((a, b) => top(a) - top(b))) {
    if (members.length <= maxRow) {
      for (const n of members) out.set(n.key, { x: at(n).x, y: at(n).y + shift });
      continue;
    }
    const sorted = [...members].sort((a, b) => at(a).x - at(b).x);
    const w = Math.max(...sorted.map((n) => n.w));
    const h = Math.max(...sorted.map((n) => n.h));
    const x0 = Math.min(...sorted.map((n) => at(n).x));
    const y0 = top(sorted) + shift;
    sorted.forEach((n, i) => {
      const row = Math.floor(i / maxRow);
      out.set(n.key, { x: x0 + (i % maxRow) * (w + GAP_X), y: y0 + row * (h + GAP_Y) });
    });
    shift += (Math.ceil(sorted.length / maxRow) - 1) * (h + GAP_Y);
  }
  return out;
}
