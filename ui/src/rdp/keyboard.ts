import type { RdpInput } from "@/lib/ipc";

/**
 * Keyboard and mouse translation for the RDP view. Keys travel as physical
 * `KeyboardEvent.code` values (mapped to scancodes in Rust), so the server's keyboard
 * layout applies whatever the local one is.
 */

/** The key event to send, or `null` for keys that must not reach the server. */
export function keyInput(
  e: KeyboardEvent,
  opts: { mac: boolean; cmdAsCtrl: boolean },
): RdpInput | null {
  if (!e.code || e.code === "Unidentified") return null;
  let code = e.code;
  // On a Mac the Command key does what Ctrl does on Windows (copy, paste, undo…).
  if (opts.mac && opts.cmdAsCtrl) {
    if (code === "MetaLeft") code = "ControlLeft";
    else if (code === "MetaRight") code = "ControlRight";
  }
  return { kind: "key", code, down: e.type === "keydown" };
}

/** Pixel or line wheel deltas → RDP rotation units (120 per notch, positive = away). */
export function wheelUnits(delta: number, deltaMode: number): number {
  const notches = deltaMode === 1 ? delta / 3 : deltaMode === 2 ? delta : delta / 100;
  const units = Math.round(-notches * 120);
  return Math.max(-255, Math.min(255, units));
}

/** A point in the displayed canvas → desktop pixels. */
export function toDesktop(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  desktop: { width: number; height: number },
): { x: number; y: number } {
  const fx = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
  const fy = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max - 1, Math.floor(v)));
  return {
    x: clamp(fx * desktop.width, desktop.width),
    y: clamp(fy * desktop.height, desktop.height),
  };
}
