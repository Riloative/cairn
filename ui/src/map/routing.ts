import { PARALLEL_GAP, route, type Point, type Route, type RouteEnd, type Side } from "./geometry";
import type { Rect } from "./geometry";

/** A node links attach to; `tile` is a device's icon tile (sideways exits). */
export interface RouteNode {
  key: string;
  rect: Rect;
  tile?: Rect;
}

export interface RouteEdge {
  key: string;
  source: string;
  target: string;
  /** Offset among parallel links of the same pair. */
  offset: number;
}

/** Gap between links of different peers that leave a node on the same side. */
const SLOT_GAP = 16;

interface End {
  edge: RouteEdge;
  /** 0: the source end, 1: the target end. */
  index: 0 | 1;
  /** Parallel links of one pair share a slot (they are offset within it). */
  pair: string;
  /** The far end, to order slots so that links do not cross near the node. */
  far: Point;
}

const pairOf = (e: RouteEdge) => [e.source, e.target].sort().join("|");

/**
 * Routes for every link of a view. Each link avoids the other nodes; links of
 * different peers that leave a node on the same side get their own attachment slot
 * along that side (ordered by where they go), so lines and port labels don't overlap.
 * Shared by the canvas and the exporter.
 */
export function routeAll(
  nodes: readonly RouteNode[],
  edges: readonly RouteEdge[],
): Map<string, Route> {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const obstaclesFor = (e: RouteEdge) =>
    nodes.filter((n) => n.key !== e.source && n.key !== e.target).map((n) => n.rect);
  const routeOne = (e: RouteEdge, shiftA = 0, shiftB = 0): Route | null => {
    const a = byKey.get(e.source);
    const b = byKey.get(e.target);
    if (!a || !b) return null;
    return route(a.rect, b.rect, e.offset, {
      obstacles: obstaclesFor(e),
      sideA: a.tile,
      sideB: b.tile,
      shiftA,
      shiftB,
    });
  };

  const first = new Map<string, Route>();
  for (const e of edges) {
    const r = routeOne(e);
    if (r) first.set(e.key, r);
  }

  // Group route ends by node side.
  const sides = new Map<string, End[]>();
  for (const e of edges) {
    const r = first.get(e.key);
    if (!r) continue;
    for (const index of [0, 1] as const) {
      const node = index === 0 ? e.source : e.target;
      const key = `${node}|${r.ends[index].side}`;
      const far = r.ends[index === 0 ? 1 : 0];
      sides.set(key, [...(sides.get(key) ?? []), { edge: e, index, pair: pairOf(e), far }]);
    }
  }

  const shifts = new Map<string, [number, number]>();
  for (const [key, ends] of sides) {
    const pairs = [...new Set(ends.map((x) => x.pair))];
    if (pairs.length < 2) continue;
    const side = key.slice(key.lastIndexOf("|") + 1) as Side;
    const along = (p: Point) => (side === "left" || side === "right" ? p.y : p.x);
    // One slot per peer, ordered by the average position of where its links go.
    const slots = pairs
      .map((pair) => {
        const members = ends.filter((x) => x.pair === pair);
        const pos = members.reduce((n, x) => n + along(x.far), 0) / members.length;
        const width = (new Set(members.map((x) => x.edge.key)).size - 1) * PARALLEL_GAP;
        return { pair, pos, width, members };
      })
      .sort((p, q) => p.pos - q.pos);
    const total = slots.reduce((n, x) => n + x.width, 0) + (slots.length - 1) * SLOT_GAP;
    let cursor = -total / 2;
    for (const slot of slots) {
      const shift = cursor + slot.width / 2;
      cursor += slot.width + SLOT_GAP;
      for (const m of slot.members) {
        const cur = shifts.get(m.edge.key) ?? [0, 0];
        cur[m.index] = shift;
        shifts.set(m.edge.key, cur);
      }
    }
  }

  const out = new Map(first);
  for (const [key, [sa, sb]] of shifts) {
    const e = edges.find((x) => x.key === key);
    const r = e && routeOne(e, sa, sb);
    if (r) out.set(key, r);
  }
  numberSlots(out, edges);
  return out;
}

/** Record each end's position among the ends on the same node side (label placement). */
function numberSlots(routes: Map<string, Route>, edges: readonly RouteEdge[]) {
  const groups = new Map<string, RouteEnd[]>();
  for (const e of edges) {
    const r = routes.get(e.key);
    if (!r) continue;
    r.ends.forEach((end, i) => {
      const key = `${i === 0 ? e.source : e.target}|${end.side}`;
      groups.set(key, [...(groups.get(key) ?? []), end]);
    });
  }
  for (const ends of groups.values()) {
    const horizontal = ends[0]?.side === "top" || ends[0]?.side === "bottom";
    ends
      .sort((p, q) => (horizontal ? p.x - q.x : p.y - q.y))
      .forEach((end, index) => (end.slot = { index, count: ends.length }));
  }
}
