/** True when running on macOS (used for Cmd vs Ctrl shortcut labels). */
export function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);
}

/** Label for the primary modifier key: ⌘ on macOS, Ctrl elsewhere. */
export function modKeyLabel(): string {
  return isMac() ? "⌘" : "Ctrl";
}
