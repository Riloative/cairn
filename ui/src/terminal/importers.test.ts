import { describe, expect, it } from "vitest";
import { ALACRITTY, GHOSTTY, ITERM, WINDOWS_TERMINAL } from "./importers.fixtures";
import { detectFormat, importPalette, parseGhostty } from "./importers";
import { findPalette } from "./palettes";

const dracula = findPalette("dracula");

describe("palette import", () => {
  it.each([
    ["Dracula.itermcolors", ITERM, "itermcolors"],
    ["dracula", GHOSTTY, "ghostty"],
    ["Dracula.json", WINDOWS_TERMINAL, "windows-terminal"],
    ["dracula.toml", ALACRITTY, "alacritty"],
  ])("%s → same colors as the bundled Dracula", (file, text, format) => {
    expect(detectFormat(file, text)).toBe(format);
    const p = importPalette(file, text);
    expect(p.id.startsWith("custom-")).toBe(true);
    expect(p.scheme).toBe("dark");
    expect(p.colors).toEqual(dracula?.colors);
  });

  it("takes the scheme name from Windows Terminal JSON", () => {
    expect(importPalette("x.json", WINDOWS_TERMINAL).name).toBe("Dracula");
  });

  it("explains incomplete schemes", () => {
    expect(() => parseGhostty("background = #000000\nforeground = #ffffff\n", "x")).toThrow(
      /missing colors: black/,
    );
    expect(() => importPalette("x.json", "{not json")).toThrow(/not valid JSON/);
    expect(() => importPalette("x.itermcolors", "<plist><oops")).toThrow(/itermcolors/);
  });
});
