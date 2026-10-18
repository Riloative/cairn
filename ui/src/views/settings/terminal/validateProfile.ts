import type { TerminalProfile } from "@/lib/ipc";

/** Mirrors `TerminalProfile::validate` in crates/core (user-facing messages). */
export function validateProfile(p: TerminalProfile): string | null {
  if (!p.name.trim()) return "Give the profile a name.";
  if (p.fontSize < 6 || p.fontSize > 48) return "Font size must be 6–48.";
  if (p.lineHeight < 1 || p.lineHeight > 2) return "Line height must be 1.0–2.0.";
  if (p.scrollback < 100 || p.scrollback > 1_000_000) return "Scrollback must be 100–1,000,000.";
  if (p.opacity < 0.5 || p.opacity > 1) return "Opacity must be 50–100%.";
  if (p.pasteLineDelayMs < 0 || p.pasteLineDelayMs > 5000) return "Paste delay must be 0–5000 ms.";
  return null;
}
