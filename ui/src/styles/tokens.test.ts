import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { THEMES } from "@/lib/theme";

// Vitest runs from the repo root (see vite.config.ts `test.root`).
const css = readFileSync(resolve(process.cwd(), "ui/src/styles/tokens.css"), "utf8");

function themeBlock(name: string): Record<string, string> {
  const re = new RegExp(`\\[data-theme="${name}"\\]\\s*\\{([^}]*)\\}`);
  const body = re.exec(css)?.[1];
  if (!body) throw new Error(`theme ${name} missing from tokens.css`);
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) vars[m[1]!] = m[2]!.trim();
  vars["color-scheme"] = /color-scheme:\s*(\w+);/.exec(body)?.[1] ?? "";
  return vars;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const REQUIRED = [
  "bg",
  "bg-subtle",
  "surface",
  "surface-raised",
  "border",
  "border-strong",
  "fg",
  "fg-muted",
  "fg-subtle",
  "accent",
  "accent-fg",
  "accent-subtle",
  "accent-text",
  "success",
  "warning",
  "danger",
  "danger-solid",
  "focus-ring",
  "shadow-sm",
  "shadow-md",
  "shadow-lg",
];

describe.each(THEMES.map((t) => [t.id, t] as const))("theme %s", (id, theme) => {
  const v = themeBlock(id);

  it("defines every token", () => {
    for (const key of REQUIRED) expect(v, key).toHaveProperty(key);
    expect(v["color-scheme"]).toBe(theme.scheme);
  });

  it.each(["bg", "bg-subtle", "surface", "surface-raised"])(
    "body text meets WCAG AAA (7:1) on %s",
    (surface) => {
      expect(contrast(v.fg!, v[surface]!)).toBeGreaterThanOrEqual(7);
    },
  );

  it.each(["bg", "bg-subtle", "surface", "surface-raised"])(
    "muted text meets WCAG AA (4.5:1) on %s",
    (surface) => {
      expect(contrast(v["fg-muted"]!, v[surface]!)).toBeGreaterThanOrEqual(4.5);
    },
  );

  const SURFACES = ["bg", "bg-subtle", "surface", "surface-raised"];

  // Subtle text, accent links and status messages are all small text in the UI
  // (headers, counts, errors), so they need the full 4.5:1 on every surface.
  it.each(["fg-subtle", "accent-text", "success", "warning", "danger"])(
    "%s text meets WCAG AA (4.5:1) on every surface",
    (key) => {
      for (const surface of SURFACES) {
        expect(contrast(v[key]!, v[surface]!), surface).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it("the focus ring is visible (3:1) on every surface", () => {
    for (const surface of SURFACES) {
      expect(contrast(v["focus-ring"]!, v[surface]!), surface).toBeGreaterThanOrEqual(3);
    }
  });

  it("accent and danger buttons are readable", () => {
    expect(contrast(v["accent-fg"]!, v.accent!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ffffff", v["danger-solid"]!)).toBeGreaterThanOrEqual(4.5);
  });
});
