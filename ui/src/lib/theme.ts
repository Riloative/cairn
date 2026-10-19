/**
 * App theme handling. Settings store a `ThemeSetting` ("system" or a theme id); this module
 * resolves it to a concrete theme and applies it as `data-theme` on <html>. The resolved
 * choice is cached in localStorage so the lock screen renders in the right theme before
 * the encrypted settings are readable. Theme names are not sensitive.
 */

export type ThemeId = "midnight" | "graphite" | "obsidian" | "paper" | "porcelain" | "sand";
export type ThemeSetting = "system" | ThemeId;

export interface ThemeInfo {
  id: ThemeId;
  label: string;
  scheme: "dark" | "light";
  /** Swatch colors for the picker: background, surface, accent. */
  swatch: [string, string, string];
}

export const THEMES: readonly ThemeInfo[] = [
  { id: "midnight", label: "Midnight", scheme: "dark", swatch: ["#0d0e12", "#1e1f26", "#6a5ae0"] },
  { id: "graphite", label: "Graphite", scheme: "dark", swatch: ["#1a1a1c", "#2b2b2f", "#3b6fd4"] },
  { id: "obsidian", label: "Obsidian", scheme: "dark", swatch: ["#050506", "#16161a", "#2fb5a5"] },
  { id: "paper", label: "Paper", scheme: "light", swatch: ["#ffffff", "#f2f2f4", "#6253e1"] },
  {
    id: "porcelain",
    label: "Porcelain",
    scheme: "light",
    swatch: ["#f4f6f9", "#e7ebf1", "#2d6fd6"],
  },
  { id: "sand", label: "Sand", scheme: "light", swatch: ["#f6f1e9", "#ebe3d6", "#b4532a"] },
];

/** Picker swatch for "Follow system": half dark, half light. */
export const SYSTEM_SWATCH: [string, string, string] = ["#0d0e12", "#f2f2f4", "#6a5ae0"];

export const DARK_THEMES = THEMES.filter((t) => t.scheme === "dark");
export const LIGHT_THEMES = THEMES.filter((t) => t.scheme === "light");

export interface ThemePrefs {
  theme: ThemeSetting;
  systemDarkTheme: ThemeId;
  systemLightTheme: ThemeId;
}

export const DEFAULT_THEME_PREFS: ThemePrefs = {
  theme: "system",
  systemDarkTheme: "midnight",
  systemLightTheme: "paper",
};

const CACHE_KEY = "cairn.themePrefs";

export function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : true;
}

export function resolveTheme(prefs: ThemePrefs, prefersDark: boolean): ThemeId {
  if (prefs.theme !== "system") return prefs.theme;
  return prefersDark ? prefs.systemDarkTheme : prefs.systemLightTheme;
}

export function applyTheme(prefs: ThemePrefs): ThemeId {
  const id = resolveTheme(prefs, systemPrefersDark());
  document.documentElement.dataset.theme = id;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage can be unavailable; the theme still applies for this session.
  }
  return id;
}

export function cachedThemePrefs(): ThemePrefs {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) return { ...DEFAULT_THEME_PREFS, ...(JSON.parse(raw) as Partial<ThemePrefs>) };
  } catch {
    // Fall through to defaults.
  }
  return DEFAULT_THEME_PREFS;
}

/** Re-apply when the OS switches light/dark. Returns an unsubscribe function. */
export function watchSystemTheme(getPrefs: () => ThemePrefs): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => applyTheme(getPrefs());
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
