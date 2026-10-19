import { describe, expect, it } from "vitest";
import { COLOR_KEYS, isHexColor, luminance, schemeOf, toXtermTheme } from "./palette";
import { BUNDLED_PALETTES, defaultPaletteFor, findPalette } from "./palettes";

function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("bundled palettes", () => {
  it("ships at least 15 with unique ids and MIT attribution", () => {
    expect(BUNDLED_PALETTES.length).toBeGreaterThanOrEqual(15);
    expect(new Set(BUNDLED_PALETTES.map((p) => p.id)).size).toBe(BUNDLED_PALETTES.length);
    for (const p of BUNDLED_PALETTES) expect(p.license).toBe("MIT");
  });

  it.each(BUNDLED_PALETTES.map((p) => [p.id, p] as const))("%s is complete and valid", (_, p) => {
    for (const key of COLOR_KEYS) expect(isHexColor(p.colors[key]), key).toBe(true);
    expect(schemeOf(p.colors.background)).toBe(p.scheme);
    // 4:1 rather than 4.5:1: Solarized Light's canonical foreground is 4.1:1 by design,
    // and bundled palettes keep their upstream colors.
    expect(contrast(p.colors.foreground, p.colors.background)).toBeGreaterThanOrEqual(4);
  });

  it("includes the families the spec names", () => {
    for (const id of [
      "catppuccin-mocha",
      "dracula",
      "nord",
      "gruvbox-dark",
      "solarized-dark",
      "tokyo-night",
      "one-dark",
      "rose-pine",
      "github-light",
      "github-dark",
    ]) {
      expect(findPalette(id), id).toBeDefined();
    }
  });

  it("has a default for each scheme", () => {
    expect(defaultPaletteFor("dark").scheme).toBe("dark");
    expect(defaultPaletteFor("light").scheme).toBe("light");
  });

  it("applies opacity to the background only", () => {
    const p = defaultPaletteFor("dark");
    expect(toXtermTheme(p).background).toBe(p.colors.background);
    expect(toXtermTheme(p, 0.5).background).toBe(`${p.colors.background}80`);
    expect(toXtermTheme(p, 0.5).foreground).toBe(p.colors.foreground);
  });
});
