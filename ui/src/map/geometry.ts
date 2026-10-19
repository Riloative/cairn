/**
 * Link geometry shared by the canvas and the SVG exporter: orthogonal routes between
 * node boxes, with parallel links offset so they never cross each other.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Side = "left" | "right" | "top" | "bottom";

export interface Route {
  points: Point[];
  /** SVG path with rounded corners. */
  path: string;
  /** Middle of the middle segment (speed / VLAN labels). */
  mid: Point;
  /** Where the route leaves each box, and on which side (port labels). */
  ends: [RouteEnd, RouteEnd];
}

export interface RouteEnd extends Point {
  side: Side;
  /** Position among the links on the same side of the node (set by `routeAll`). */
  slot?: { index: number; count: number };
}

/** Gap between parallel links of the same pair. */
export const PARALLEL_GAP = 12;
const CORNER = 6;

const center = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Offset of the `index`-th of `count` parallel links. */
export function parallelOffset(index: number, count: number): number {
  return (index - (count - 1) / 2) * PARALLEL_GAP;
}

export interface RouteOptions {
  /** Boxes the route should not cross (other nodes); the two ends are excluded. */
  obstacles?: readonly Rect[];
  /** Narrower boxes for left/right exits (a device's icon tile rather than its label). */
  sideA?: Rect;
  sideB?: Rect;
  /** Extra shift of each end along its side (several links on one side of a node). */
  shiftA?: number;
  shiftB?: number;
}

type Axis = "h" | "v";

/** Step between candidate bend positions when avoiding obstacles. */
const BEND_STEP = 8;
/** How much wider than tall a gap must be for a sideways (left/right) route. */
const SIDEWAYS = 1.5;
/** Minimum straight run out of a box before the first bend. */
const STUB = 12;

function crosses(p: Point, q: Point, r: Rect): boolean {
  const m = 2;
  const [x1, x2] = p.x < q.x ? [p.x, q.x] : [q.x, p.x];
  const [y1, y2] = p.y < q.y ? [p.y, q.y] : [q.y, p.y];
  return x2 > r.x + m && x1 < r.x + r.w - m && y2 > r.y + m && y1 < r.y + r.h - m;
}

function hits(points: readonly Point[], obstacles: readonly Rect[]): number {
  let n = 0;
  for (const r of obstacles)
    for (let i = 1; i < points.length; i++)
      if (crosses(points[i - 1] as Point, points[i] as Point, r)) {
        n += 1;
        break;
      }
  return n;
}

/**
 * Candidate routes along one axis: leave `a` on the side facing `b`, bend once at
 * `bend` (shifted against the direction of travel by `offset` so parallel routes stay
 * apart), enter `b` on the opposite side.
 */
function along(
  axis: Axis,
  a: Rect,
  b: Rect,
  offset: number,
  shift: number,
  [sa, sb]: [number, number],
): {
  points: Point[];
  sides: [Side, Side];
  span: number;
} {
  const ca = center(a);
  const cb = center(b);
  if (axis === "h") {
    const dir = Math.sign(cb.x - ca.x) || 1;
    const ya = clamp(ca.y + offset + sa, a.y + 4, a.y + a.h - 4);
    const yb = clamp(cb.y + offset + sb, b.y + 4, b.y + b.h - 4);
    const xa = dir > 0 ? a.x + a.w : a.x;
    const xb = dir > 0 ? b.x : b.x + b.w;
    const midX = (xa + xb) / 2 - offset * Math.sign(cb.y - ca.y) * dir + shift;
    const points =
      Math.abs(ya - yb) < 1 && shift === 0
        ? [
            { x: xa, y: ya },
            { x: xb, y: ya },
          ]
        : [
            { x: xa, y: ya },
            { x: midX, y: ya },
            { x: midX, y: yb },
            { x: xb, y: yb },
          ];
    return {
      points,
      sides: dir > 0 ? ["right", "left"] : ["left", "right"],
      span: (xb - xa) * dir,
    };
  }
  const dir = Math.sign(cb.y - ca.y) || 1;
  const xa = clamp(ca.x + offset + sa, a.x + 4, a.x + a.w - 4);
  const xb = clamp(cb.x + offset + sb, b.x + 4, b.x + b.w - 4);
  const ya = dir > 0 ? a.y + a.h : a.y;
  const yb = dir > 0 ? b.y : b.y + b.h;
  const midY = (ya + yb) / 2 - offset * Math.sign(cb.x - ca.x) * dir + shift;
  const points =
    Math.abs(xa - xb) < 1 && shift === 0
      ? [
          { x: xa, y: ya },
          { x: xa, y: yb },
        ]
      : [
          { x: xa, y: ya },
          { x: xa, y: midY },
          { x: xb, y: midY },
          { x: xb, y: yb },
        ];
  return { points, sides: dir > 0 ? ["bottom", "top"] : ["top", "bottom"], span: (yb - ya) * dir };
}

/**
 * A "U" around the row: leave `a` from its bottom (or top), run below (above) both
 * boxes at `depth` beyond them, and enter `b` from the same side. Used when boxes on
 * one row have other nodes between them.
 */
function detour(
  a: Rect,
  b: Rect,
  offset: number,
  below: boolean,
  depth: number,
  [sa, sb]: [number, number],
): { points: Point[]; sides: [Side, Side]; span: number } {
  // Parallel detours nest: a deeper one starts further out on both boxes, whichever
  // box is `a`.
  const dir = Math.sign(b.x + b.w / 2 - (a.x + a.w / 2)) || 1;
  const xa = clamp(a.x + a.w / 2 - offset * dir + sa, a.x + 4, a.x + a.w - 4);
  const xb = clamp(b.x + b.w / 2 + offset * dir + sb, b.x + 4, b.x + b.w - 4);
  const ya = below ? a.y + a.h : a.y;
  const yb = below ? b.y + b.h : b.y;
  const edge = below ? Math.max(ya, yb) : Math.min(ya, yb);
  const y = edge + (below ? 1 : -1) * (depth + offset);
  const side: Side = below ? "bottom" : "top";
  return {
    points: [
      { x: xa, y: ya },
      { x: xa, y },
      { x: xb, y },
      { x: xb, y: yb },
    ],
    sides: [side, side],
    span: 0,
  };
}

/**
 * Orthogonal route from box `a` to box `b`. The dominant axis decides the exit sides;
 * the middle bend is shifted against the direction of travel so that parallel routes
 * (different `offset`) stay apart instead of crossing. With `obstacles`, the bend moves
 * (or the route switches to the other axis when the boxes are apart on it) to cross as
 * few other nodes as possible.
 */
export function route(a: Rect, b: Rect, offset = 0, opts: RouteOptions = {}): Route {
  const ca = center(a);
  const cb = center(b);
  // Between rows, links leave from the top/bottom unless clearly sideways: side exits
  // crowd the port labels of same-row links (LAG members, peers).
  const dominant: Axis = Math.abs(cb.x - ca.x) >= Math.abs(cb.y - ca.y) * SIDEWAYS ? "h" : "v";
  const shifts: [number, number] = [opts.shiftA ?? 0, opts.shiftB ?? 0];
  const boxes = (axis: Axis): [Rect, Rect] =>
    axis === "h" ? [opts.sideA ?? a, opts.sideB ?? b] : [a, b];

  let best = along(dominant, ...boxes(dominant), offset, 0, shifts);
  const obstacles = opts.obstacles ?? [];
  if (obstacles.length && hits(best.points, obstacles) > 0) {
    let bestCost = Infinity;
    for (const axis of [dominant, dominant === "h" ? "v" : "h"] as const) {
      const [ra, rb] = boxes(axis);
      const base = along(axis, ra, rb, offset, 0, shifts);
      // The other axis only when the boxes are clearly apart along it.
      if (axis !== dominant && base.span < 2 * STUB) continue;
      const room = Math.max(0, base.span / 2 - STUB);
      for (let k = 0; k * BEND_STEP <= room; k++) {
        for (const sign of k === 0 ? [1] : [1, -1]) {
          const c = along(axis, ra, rb, offset, sign * k * BEND_STEP, shifts);
          const cost = hits(c.points, obstacles) * 1000 + (axis === dominant ? 0 : 40) + k;
          if (cost < bestCost) {
            bestCost = cost;
            best = c;
          }
        }
      }
    }
    // Still blocked: go around the row, below first.
    if (bestCost >= 1000) {
      for (let k = 0; k < 24; k++) {
        for (const below of [true, false]) {
          const c = detour(a, b, offset, below, 2 * STUB + k * BEND_STEP, shifts);
          const cost = hits(c.points, obstacles) * 1000 + 60 + k + (below ? 0 : 1);
          if (cost < bestCost) {
            bestCost = cost;
            best = c;
          }
        }
      }
    }
  }

  const { points, sides } = best;
  const first = points[0] as Point;
  const last = points[points.length - 1] as Point;
  // The middle segment: the bend for 4-point routes, the whole line otherwise.
  const [s1, s2] = points.length === 4 ? [points[1] as Point, points[2] as Point] : [first, last];
  const mid = { x: (s1.x + s2.x) / 2, y: (s1.y + s2.y) / 2 };
  return {
    points,
    path: roundedPath(points),
    mid,
    ends: [
      { ...first, side: sides[0] },
      { ...last, side: sides[1] },
    ],
  };
}

/** Ellipse drawn around the middle of a LAG bundle (its first and last member). */
export function lagMarker(
  first: Route,
  last: Route,
): { cx: number; cy: number; rx: number; ry: number } {
  const cx = (first.mid.x + last.mid.x) / 2;
  const cy = (first.mid.y + last.mid.y) / 2;
  const half = Math.hypot(first.mid.x - last.mid.x, first.mid.y - last.mid.y) / 2 + 6;
  // Members run side by side: the ellipse spans across them, perpendicular to the lines.
  const across = Math.abs(first.mid.x - last.mid.x) >= Math.abs(first.mid.y - last.mid.y);
  return across ? { cx, cy, rx: half, ry: 9 } : { cx, cy, rx: 9, ry: half };
}

/** Polyline through `points` with small rounded corners. */
export function roundedPath(points: readonly Point[]): string {
  if (points.length === 0) return "";
  const f = (n: number) => Math.round(n * 10) / 10;
  const p0 = points[0] as Point;
  let d = `M${f(p0.x)} ${f(p0.y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1] as Point;
    const cur = points[i] as Point;
    const next = points[i + 1] as Point;
    const r = Math.min(
      CORNER,
      Math.hypot(cur.x - prev.x, cur.y - prev.y) / 2,
      Math.hypot(next.x - cur.x, next.y - cur.y) / 2,
    );
    const inDir = { x: Math.sign(cur.x - prev.x), y: Math.sign(cur.y - prev.y) };
    const outDir = { x: Math.sign(next.x - cur.x), y: Math.sign(next.y - cur.y) };
    d += ` L${f(cur.x - inDir.x * r)} ${f(cur.y - inDir.y * r)}`;
    d += ` Q${f(cur.x)} ${f(cur.y)} ${f(cur.x + outDir.x * r)} ${f(cur.y + outDir.y * r)}`;
  }
  const pn = points[points.length - 1] as Point;
  d += ` L${f(pn.x)} ${f(pn.y)}`;
  return d;
}

/** Where to put a port label next to a route end. */
export function portLabelAt(end: RouteEnd): Point & { anchor: "start" | "end" | "middle" } {
  const gap = 6;
  if (end.side === "left" || end.side === "right") {
    // Links on one side are at least a slot apart vertically: labels just sit above.
    return end.side === "right"
      ? { x: end.x + gap, y: end.y - gap, anchor: "start" }
      : { x: end.x - gap, y: end.y - gap, anchor: "end" };
  }
  const y = end.side === "bottom" ? end.y + 14 : end.y - 6;
  const { index, count } = end.slot ?? { index: 0, count: 1 };
  if (count === 1) return { x: end.x + gap, y, anchor: "start" };
  // Several links on the top/bottom: labels fan out away from the middle; a middle
  // link's label goes one line further out.
  const middle = (count - 1) / 2;
  if (index < middle) return { x: end.x - gap, y, anchor: "end" };
  if (index > middle) return { x: end.x + gap, y, anchor: "start" };
  return { x: end.x, y: end.side === "bottom" ? y + 12 : y - 12, anchor: "middle" };
}

/** Bounding box of rects (for fit, export and layout of new nodes). */
export function bounds(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x1 = Infinity,
    y1 = Infinity,
    x2 = -Infinity,
    y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
