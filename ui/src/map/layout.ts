import ELK from "elkjs/lib/elk.bundled.js";
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

const elk = new ELK();

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
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
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
  const out = await elk.layout(graph);
  const snap = (v: number) => Math.round(v / grid) * grid;
  const result = new Map<string, { x: number; y: number }>();
  for (const c of out.children ?? [])
    result.set(c.id, { x: snap(origin.x + (c.x ?? 0)), y: snap(origin.y + (c.y ?? 0)) });
  return result;
}
