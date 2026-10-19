import type { SessionTab } from "@/stores/sessions";

export type HeaderTint = "local" | "remote" | "serial" | "privileged";

export function headerTint(tab: SessionTab, privileged: boolean): HeaderTint {
  if (privileged) return "privileged";
  if (tab.protocol === "serial") return "serial";
  if (tab.protocol === "ssh" || tab.protocol === "telnet") return "remote";
  return "local";
}

/** Background class for each tint (the header and the active tab above it). */
export const TINT_CLASS: Record<HeaderTint, string> = {
  local: "bg-surface",
  remote: "bg-tint-remote",
  serial: "bg-tint-serial",
  privileged: "bg-tint-privileged",
};

/**
 * The tint as a layer over the card surface. Tints are translucent, so the active tab
 * (which sits on the darker bar) needs the surface underneath to match the header.
 */
export function tintOverSurface(tint: HeaderTint): {
  backgroundColor: string;
  backgroundImage?: string;
} {
  if (tint === "local") return { backgroundColor: "var(--surface)" };
  const v = `var(--tint-${tint})`;
  return { backgroundColor: "var(--surface)", backgroundImage: `linear-gradient(${v}, ${v})` };
}
