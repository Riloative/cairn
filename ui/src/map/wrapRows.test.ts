import { describe, expect, it } from "vitest";
import { wrapRows } from "./layout";

const node = (key: string) => ({ key, w: 100, h: 50 });

describe("wrapping wide layers", () => {
  it("keeps narrow layers and wraps wide ones in order, pushing later layers down", () => {
    const nodes = [node("core"), ...Array.from({ length: 5 }, (_, i) => node(`a${i}`)), node("ap")];
    const pos = new Map([
      ["core", { x: 0, y: 0 }],
      ...Array.from({ length: 5 }, (_, i) => [`a${i}`, { x: 400 - i * 100, y: 200 }] as const),
      ["ap", { x: 0, y: 400 }],
    ]);
    const layer = new Map([
      ["core", 0],
      ...nodes.slice(1, 6).map((n) => [n.key, 1] as const),
      ["ap", 2],
    ]);
    const out = wrapRows(nodes, pos, layer, 2);
    expect(out.get("core")).toEqual({ x: 0, y: 0 });
    // Sorted by x: a4 (0), a3 (100), a2, a1, a0 → rows of two.
    expect(out.get("a4")).toEqual({ x: 0, y: 200 });
    expect(out.get("a3")).toEqual({ x: 180, y: 200 });
    expect(out.get("a2")).toEqual({ x: 0, y: 314 });
    expect(out.get("a0")).toEqual({ x: 0, y: 428 });
    // Two extra rows of 114 px push the next layer down.
    expect(out.get("ap")).toEqual({ x: 0, y: 628 });
  });
});
