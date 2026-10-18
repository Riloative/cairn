import { describe, expect, it } from "vitest";
import { applyTheme, cachedThemePrefs, DEFAULT_THEME_PREFS, resolveTheme, THEMES } from "./theme";

describe("theme", () => {
  it("ships at least 3 dark and 3 light themes", () => {
    expect(THEMES.filter((t) => t.scheme === "dark").length).toBeGreaterThanOrEqual(3);
    expect(THEMES.filter((t) => t.scheme === "light").length).toBeGreaterThanOrEqual(3);
  });

  it("resolves system to the configured dark or light theme", () => {
    const prefs = {
      theme: "system",
      systemDarkTheme: "obsidian",
      systemLightTheme: "sand",
    } as const;
    expect(resolveTheme(prefs, true)).toBe("obsidian");
    expect(resolveTheme(prefs, false)).toBe("sand");
    expect(resolveTheme({ ...prefs, theme: "paper" }, true)).toBe("paper");
  });

  it("applies data-theme and caches prefs", () => {
    applyTheme({ ...DEFAULT_THEME_PREFS, theme: "graphite" });
    expect(document.documentElement.dataset.theme).toBe("graphite");
    expect(cachedThemePrefs().theme).toBe("graphite");
  });
});
