import type { ITheme } from "@xterm/xterm";

/** The 16 ANSI colors plus UI colors of a terminal palette. */
export interface PaletteColors {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface Palette {
  id: string;
  name: string;
  scheme: "dark" | "light";
  /** Author / origin, for attribution. */
  source: string;
  license: string;
  colors: PaletteColors;
}

export const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const satisfies readonly (keyof PaletteColors)[];

export const COLOR_KEYS = [
  "background",
  "foreground",
  "cursor",
  "selectionBackground",
  ...ANSI_KEYS,
] as const satisfies readonly (keyof PaletteColors)[];

const HEX = /^#[0-9a-f]{6}$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

/** Relative luminance (WCAG) of a #rrggbb color. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function schemeOf(background: string): "dark" | "light" {
  return luminance(background) < 0.4 ? "dark" : "light";
}

/** xterm.js theme for a palette, with an optional background opacity (0–1). */
export function toXtermTheme(p: Palette, opacity = 1): ITheme {
  const alpha =
    opacity >= 1
      ? ""
      : Math.round(Math.max(0, opacity) * 255)
          .toString(16)
          .padStart(2, "0");
  return {
    ...p.colors,
    background: p.colors.background + alpha,
    cursorAccent: p.colors.background,
    selectionBackground: p.colors.selectionBackground,
  };
}
