import type { Rect } from "./geometry";

/** Distance within which a dragged node snaps to another node's edge or center. */
export const GUIDE_THRESHOLD = 6;

export interface Guides {
  /** Adjusted top-left of the dragged node. */
  x: number;
  y: number;
  /** Lines to draw (canvas coordinates). */
  vertical: number | null;
  horizontal: number | null;
}

/**
 * Snap a dragged rect to the left/center/right and top/middle/bottom lines of other
 * rects when within `threshold`, and report the guide lines to show.
 */
export function alignmentGuides(
  moving: Rect,
  others: readonly Rect[],
  threshold = GUIDE_THRESHOLD,
): Guides {
  const xs = (r: Rect) => [r.x, r.x + r.w / 2, r.x + r.w];
  const ys = (r: Rect) => [r.y, r.y + r.h / 2, r.y + r.h];
  let bestX: { delta: number; line: number } | null = null;
  let bestY: { delta: number; line: number } | null = null;
  for (const o of others) {
    for (const mx of xs(moving))
      for (const ox of xs(o)) {
        const delta = ox - mx;
        if (Math.abs(delta) <= threshold && (!bestX || Math.abs(delta) < Math.abs(bestX.delta)))
          bestX = { delta, line: ox };
      }
    for (const my of ys(moving))
      for (const oy of ys(o)) {
        const delta = oy - my;
        if (Math.abs(delta) <= threshold && (!bestY || Math.abs(delta) < Math.abs(bestY.delta)))
          bestY = { delta, line: oy };
      }
  }
  return {
    x: moving.x + (bestX?.delta ?? 0),
    y: moving.y + (bestY?.delta ?? 0),
    vertical: bestX?.line ?? null,
    horizontal: bestY?.line ?? null,
  };
}
