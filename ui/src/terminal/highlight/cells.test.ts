import { describe, expect, it } from "vitest";
import { cellRange, lineText, type CellLike } from "./cells";

/** Simulate xterm cells: wide chars occupy a cell plus a zero-width continuation. */
function cells(spec: string[]): (x: number) => CellLike | undefined {
  const out: CellLike[] = [];
  for (const ch of spec) {
    const wide = /[\u3000-\u9fff]/.test(ch) || ch.length === 2;
    out.push({ getChars: () => ch, getWidth: () => (wide ? 2 : 1) });
    if (wide) out.push({ getChars: () => "", getWidth: () => 0 });
  }
  return (x) => out[x];
}

describe("line text mapping", () => {
  it("maps ASCII one to one and trims trailing blanks", () => {
    const m = lineText(cells(["u", "p", "", ""]), 4);
    expect(m.text).toBe("up");
    expect(cellRange(m, 0, 2)).toEqual({ x: 0, width: 2 });
  });

  it("accounts for wide characters", () => {
    const m = lineText(cells(["端", "口", " ", "u", "p"]), 7);
    expect(m.text).toBe("端口 up");
    const start = m.text.indexOf("up");
    expect(cellRange(m, start, start + 2)).toEqual({ x: 5, width: 2 });
  });

  it("accounts for surrogate pairs", () => {
    const m = lineText(cells(["😀", "x"]), 3);
    expect(m.text).toBe("😀x");
    expect(cellRange(m, 2, 3)).toEqual({ x: 2, width: 1 });
  });
});
