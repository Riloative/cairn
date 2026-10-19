import { describe, expect, it } from "vitest";
import { forget, touch } from "./gpuPool";

describe("WebGL pool", () => {
  it("keeps the most recently used terminals and evicts the oldest", () => {
    let order: string[] = [];
    for (const id of ["a", "b", "c"]) order = touch(order, id, 2).order;
    expect(order).toEqual(["c", "b"]);
    const r = touch(["c", "b"], "d", 2);
    expect(r).toEqual({ order: ["d", "c"], evict: ["b"] });
  });

  it("moves an existing terminal to the front without evicting", () => {
    expect(touch(["a", "b", "c"], "c", 3)).toEqual({ order: ["c", "a", "b"], evict: [] });
  });

  it("forgets closed terminals", () => {
    expect(forget(["a", "b"], "a")).toEqual(["b"]);
  });
});
