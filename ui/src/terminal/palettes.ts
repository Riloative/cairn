import { BUNDLED_PALETTES } from "./bundledPalettes";
import type { Palette } from "./palette";

export { BUNDLED_PALETTES };

/** Palette used when a profile asks to follow the app theme. */
export function defaultPaletteFor(scheme: "dark" | "light"): Palette {
  const id = scheme === "dark" ? "cairn-dark" : "cairn-light";
  const p = BUNDLED_PALETTES.find((x) => x.id === id);
  if (!p) throw new Error(`bundled palette ${id} missing`);
  return p;
}

/** Look up a palette among bundled and user-imported ones. */
export function findPalette(id: string, custom: readonly Palette[] = []): Palette | undefined {
  return custom.find((p) => p.id === id) ?? BUNDLED_PALETTES.find((p) => p.id === id);
}
