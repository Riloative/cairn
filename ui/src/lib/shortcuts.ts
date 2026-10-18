/**
 * Keyboard shortcut strings such as "Mod+K" or "Mod+Shift+L". "Mod" is ⌘ on macOS and Ctrl
 * elsewhere. Keys are matched on `KeyboardEvent.key` (case-insensitive), except digits,
 * which use `code` so Shift+number works on every layout.
 */

export type Shortcut = string;

interface Parsed {
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

function parse(shortcut: Shortcut): Parsed {
  const parts = shortcut.split("+");
  const key = parts.pop() ?? "";
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return {
    mod: mods.has("mod"),
    ctrl: mods.has("ctrl"),
    shift: mods.has("shift"),
    alt: mods.has("alt"),
    key: key.toLowerCase(),
  };
}

export function matchesShortcut(shortcut: Shortcut, e: KeyboardEvent, mac: boolean): boolean {
  const p = parse(shortcut);
  const wantMeta = mac && p.mod;
  const wantCtrl = p.ctrl || (!mac && p.mod);
  if (e.metaKey !== wantMeta || e.ctrlKey !== wantCtrl) return false;
  if (e.shiftKey !== p.shift || e.altKey !== p.alt) return false;
  if (/^[0-9]$/.test(p.key)) return e.code === `Digit${p.key}`;
  return e.key.toLowerCase() === p.key;
}

const MAC_SYMBOLS: Record<string, string> = { mod: "⌘", ctrl: "⌃", shift: "⇧", alt: "⌥" };
const PC_NAMES: Record<string, string> = { mod: "Ctrl", ctrl: "Ctrl", shift: "Shift", alt: "Alt" };
const KEY_NAMES: Record<string, string> = {
  tab: "Tab",
  enter: "Enter",
  escape: "Esc",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  ",": ",",
};

/** Split a shortcut into display keys, e.g. ["⌘", "K"] or ["Ctrl", "K"]. */
export function formatShortcut(shortcut: Shortcut, mac: boolean): string[] {
  const parts = shortcut.split("+");
  const key = parts.pop() ?? "";
  const names = mac ? MAC_SYMBOLS : PC_NAMES;
  const mods = parts.map((m) => names[m.toLowerCase()] ?? m);
  return [...mods, KEY_NAMES[key.toLowerCase()] ?? key.toUpperCase()];
}
