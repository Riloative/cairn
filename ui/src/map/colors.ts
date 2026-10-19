import type { ColorBy, Link, LinkMedia, MapPrefs, Vlan } from "@/lib/ipc";

export const MEDIA_LABEL: Record<LinkMedia, string> = {
  copper: "Copper",
  "sm-fiber": "Single-mode fiber",
  "mm-fiber": "Multi-mode fiber",
  dac: "DAC",
  wireless: "Wireless",
};

/** Speed buckets with a color each (tokens in tokens.css). */
const SPEEDS = [
  { id: "100m", label: "≤100M", mbps: 100 },
  { id: "1g", label: "1G", mbps: 1_000 },
  { id: "10g", label: "10G", mbps: 10_000 },
  { id: "25g", label: "25G", mbps: 25_000 },
  { id: "40g", label: "40G", mbps: 40_000 },
  { id: "100g", label: "100G+", mbps: 100_000 },
] as const;

/** Parse "10G", "100M", "1000", "2.5G" to Mb/s; null when unknown. */
export function speedMbps(speed: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([mgt])?/i.exec(speed);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "m").toLowerCase();
  return unit === "t" ? n * 1_000_000 : unit === "g" ? n * 1_000 : n;
}

function speedBucket(speed: string) {
  const mbps = speedMbps(speed);
  if (mbps === null) return null;
  return [...SPEEDS].reverse().find((s) => mbps >= s.mbps) ?? SPEEDS[0];
}

/** Fallback for links without a known speed or VLAN color. */
export const DEFAULT_LINK_COLOR = "var(--fg-subtle)";

/** First VLAN id of a link's VLAN list. */
function firstVlan(link: Link): number | null {
  const m = /^\s*(\d+)/.exec(link.vlans);
  return m ? Number(m[1]) : null;
}

/** CSS color (a `var(--…)` reference or a hex VLAN color) for a link. */
export function linkColor(link: Link, by: ColorBy, vlans: readonly Vlan[]): string {
  switch (by) {
    case "media":
      return `var(--link-${link.media})`;
    case "speed": {
      const b = speedBucket(link.speed);
      return b ? `var(--link-speed-${b.id})` : DEFAULT_LINK_COLOR;
    }
    case "vlan": {
      const id = firstVlan(link);
      const color = vlans.find((v) => v.vid === id)?.color;
      return color || DEFAULT_LINK_COLOR;
    }
  }
}

/** Legend entries for the links in view. */
export function legend(
  links: readonly Link[],
  by: ColorBy,
  vlans: readonly Vlan[],
): { label: string; color: string }[] {
  const seen = new Map<string, string>();
  for (const l of links) {
    let label: string;
    switch (by) {
      case "media":
        label = MEDIA_LABEL[l.media];
        break;
      case "speed":
        label = speedBucket(l.speed)?.label ?? "Unknown speed";
        break;
      case "vlan": {
        const id = firstVlan(l);
        const v = vlans.find((x) => x.vid === id);
        label = id === null ? "No VLAN" : v?.name ? `VLAN ${id} ${v.name}` : `VLAN ${id}`;
        break;
      }
    }
    if (!seen.has(label)) seen.set(label, linkColor(l, by, vlans));
  }
  return [...seen.entries()].map(([label, color]) => ({ label, color }));
}

/** Which labels a link shows: its overrides, else the global toggles. */
export function shownLabels(link: Link, prefs: MapPrefs) {
  return {
    ports: link.labels.ports ?? prefs.labels.ports,
    speed: link.labels.speed ?? prefs.labels.speed,
    vlans: link.labels.vlans ?? prefs.labels.vlans,
  };
}

/** Text in the middle of a link: speed and/or VLANs (or the cable count when aggregated). */
export function midText(links: readonly Link[], prefs: MapPrefs): string {
  const first = links[0];
  if (!first) return "";
  if (links.length > 1) {
    const speeds = [...new Set(links.map((l) => l.speed).filter(Boolean))];
    return `${links.length}×${speeds.length === 1 ? ` ${speeds[0]}` : ""}`;
  }
  const shown = shownLabels(first, prefs);
  return [shown.speed && first.speed, shown.vlans && first.vlans && `VLAN ${first.vlans}`]
    .filter(Boolean)
    .join(" · ");
}

/** Resolve `var(--x)` references against an element (for export). */
export function resolveColor(color: string, from: Element): string {
  const m = /^var\((--[\w-]+)\)$/.exec(color);
  if (!m) return color;
  return (
    getComputedStyle(from)
      .getPropertyValue(m[1] as string)
      .trim() || "#888888"
  );
}
