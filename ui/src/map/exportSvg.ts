import type { Device, InventorySnapshot, MapPrefs, Zone } from "@/lib/ipc";
import { legend, linkColor, midText, resolveColor, shownLabels } from "./colors";
import { bounds, lagMarker, portLabelAt, type Rect } from "./geometry";
import { ICON_PATHS, ICON_STROKE } from "./icons";
import { lagBundles, tileRect, type EdgeModel } from "./model";
import { routeAll } from "./routing";

/** One node as placed on the canvas when exporting. */
export interface ExportNode {
  key: string;
  kind: "device" | "building" | "external" | "band";
  x: number;
  y: number;
  w: number;
  h: number;
  device?: Device;
  label?: string;
  sub?: string;
}

export interface ExportInput {
  nodes: ExportNode[];
  edges: EdgeModel[];
  zones: Zone[];
  plan: { href: string; x: number; y: number; w: number; h: number; opacity: number } | null;
  inv: InventorySnapshot;
  prefs: MapPrefs;
  title: string;
  date: string | null;
  legend: boolean;
  /** Element whose CSS variables give the colors (current theme or a forced light one). */
  theme: Element;
}

const PAD = 32;
const FONT = "Inter, 'Inter Variable', 'Helvetica Neue', Arial, sans-serif";
const MONO = "'JetBrains Mono', 'DejaVu Sans Mono', Menlo, monospace";

export function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function icon(
  type: keyof typeof ICON_PATHS,
  x: number,
  y: number,
  size: number,
  color: string,
): string {
  const s = size / 24;
  return `<g transform="translate(${r1(x)} ${r1(y)}) scale(${s})" fill="none" stroke="${color}" stroke-width="${ICON_STROKE}" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[
    type
  ]
    .map((d) => `<path d="${d}"/>`)
    .join("")}</g>`;
}

function text(
  x: number,
  y: number,
  s: string,
  o: {
    size: number;
    color: string;
    weight?: number;
    anchor?: string;
    mono?: boolean;
    halo?: string;
  },
): string {
  const halo = o.halo
    ? ` stroke="${o.halo}" stroke-width="3" paint-order="stroke" stroke-linejoin="round"`
    : "";
  return `<text x="${r1(x)}" y="${r1(y)}" font-family="${o.mono ? MONO : FONT}" font-size="${o.size}" font-weight="${o.weight ?? 400}" fill="${o.color}" text-anchor="${o.anchor ?? "start"}"${halo}>${esc(s)}</text>`;
}

/** A standalone SVG of the given map content, with resolved colors and inline images. */
export function buildSvg(input: ExportInput): string {
  const c = (name: string) => resolveColor(`var(--${name})`, input.theme);
  const col = {
    bg: c("surface"),
    raised: c("surface-raised"),
    border: c("border"),
    strong: c("border-strong"),
    fg: c("fg"),
    muted: c("fg-muted"),
    subtle: c("fg-subtle"),
  };
  const rects: Rect[] = input.nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
  for (const z of input.zones) rects.push({ x: z.x, y: z.y, w: z.width, h: z.height });
  if (input.plan)
    rects.push({ x: input.plan.x, y: input.plan.y, w: input.plan.w, h: input.plan.h });
  const box = bounds(rects) ?? { x: 0, y: 0, w: 200, h: 100 };
  const header = input.title || input.date ? 44 : 0;
  const links = input.edges.flatMap((e) => e.links);
  const legendItems = input.legend ? legend(links, input.prefs.colorBy, input.inv.vlans) : [];
  const footer = legendItems.length ? 40 : 0;
  const ox = PAD - box.x;
  const oy = PAD + header - box.y;
  const width = Math.ceil(box.w + PAD * 2);
  const height = Math.ceil(box.h + PAD * 2 + header + footer);
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${col.bg}"/>`,
  );
  if (input.title)
    out.push(text(PAD, PAD + 4, input.title, { size: 16, weight: 600, color: col.fg }));
  if (input.date)
    out.push(text(width - PAD, PAD + 4, input.date, { size: 11, color: col.muted, anchor: "end" }));
  out.push(`<g transform="translate(${r1(ox)} ${r1(oy)})">`);

  if (input.plan) {
    const p = input.plan;
    out.push(
      `<image href="${p.href}" x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" opacity="${p.opacity}" preserveAspectRatio="none"/>`,
    );
  }
  for (const n of input.nodes.filter((x) => x.kind === "band")) {
    out.push(
      `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="12" fill="${col.raised}" fill-opacity="0.4" stroke="${col.border}"/>`,
    );
    out.push(text(n.x + 12, n.y + 18, n.label ?? "", { size: 12, weight: 600, color: col.muted }));
  }
  for (const z of input.zones) {
    const zc = z.color || col.subtle;
    out.push(
      `<rect x="${z.x}" y="${z.y}" width="${z.width}" height="${z.height}" rx="12" fill="${zc}" fill-opacity="0.07" stroke="${zc}" stroke-width="2" stroke-dasharray="6 4"/>`,
    );
    out.push(text(z.x + 10, z.y + 18, z.name, { size: 12, weight: 600, color: zc }));
  }

  // Links under nodes, routed exactly as on the canvas.
  const routes = routeAll(
    input.nodes
      .filter((n) => n.kind !== "band")
      .map((n) => {
        const rect = { x: n.x, y: n.y, w: n.w, h: n.h };
        return { key: n.key, rect, tile: n.kind === "building" ? undefined : tileRect(rect) };
      }),
    input.edges,
  );
  const bundles = lagBundles(input.edges);
  const labels: string[] = [];
  for (const e of input.edges) {
    const r = routes.get(e.key);
    const first = e.links[0];
    if (!r || !first) continue;
    const color = resolveColor(linkColor(first, input.prefs.colorBy, input.inv.vlans), input.theme);
    const aggregated = e.links.length > 1;
    const w = aggregated ? 2 + Math.min(3, Math.log2(e.links.length)) : 1.75;
    const dash = first.media === "wireless" ? ` stroke-dasharray="5 4"` : "";
    out.push(`<path d="${r.path}" fill="none" stroke="${color}" stroke-width="${w}"${dash}/>`);
    const shown = shownLabels(first, input.prefs);
    const halo = col.bg;
    if (!aggregated && shown.ports) {
      const aIsSource = `d:${first.aDeviceId}` === e.source;
      const [sp, tp] = aIsSource ? [first.aName, first.bName] : [first.bName, first.aName];
      for (const [end, name] of [
        [r.ends[0], sp],
        [r.ends[1], tp],
      ] as const) {
        const l = portLabelAt(end);
        labels.push(
          text(l.x, l.y + 3, name, {
            size: 10,
            color: col.muted,
            anchor: l.anchor,
            mono: true,
            halo,
          }),
        );
      }
    }
    const members = bundles.get(e.key);
    const last = members && routes.get(members[members.length - 1] as string);
    if (last) {
      const m = lagMarker(r, last);
      out.push(
        `<ellipse cx="${r1(m.cx)}" cy="${r1(m.cy)}" rx="${r1(m.rx)}" ry="${r1(m.ry)}" fill="none" stroke="${color}" stroke-width="1.25"/>`,
      );
      labels.push(
        text(m.cx + m.rx + 4, m.cy - m.ry, first.lag, {
          size: 10,
          color: col.muted,
          mono: true,
          halo,
        }),
      );
    }
    const mid = midText(e.links, input.prefs);
    if (mid)
      labels.push(
        text(r.mid.x, r.mid.y + 3, mid, {
          size: 10,
          color: col.muted,
          anchor: "middle",
          mono: true,
          halo,
        }),
      );
  }

  for (const n of input.nodes) {
    if (n.kind === "building") {
      out.push(
        `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="12" fill="${col.bg}" stroke="${col.border}"/>`,
      );
      out.push(icon("building", n.x + 12, n.y + 12, 22, col.muted));
      out.push(text(n.x + 42, n.y + 28, n.label ?? "", { size: 13, weight: 600, color: col.fg }));
      if (n.sub) out.push(text(n.x + 12, n.y + 62, n.sub, { size: 11, color: col.muted }));
      continue;
    }
    if ((n.kind !== "device" && n.kind !== "external") || !n.device) continue;
    const d = n.device;
    const tx = n.x + (n.w - 44) / 2;
    const ty = n.y + 4;
    const ext = n.kind === "external";
    out.push(`<g${ext ? ` opacity="0.6"` : ""}>`);
    out.push(
      `<rect x="${r1(tx)}" y="${ty}" width="44" height="44" rx="8" fill="${col.bg}" stroke="${ext ? col.strong : col.border}"${ext ? ` stroke-dasharray="3 3"` : ""}/>`,
    );
    out.push(icon(d.deviceType, tx + 10, ty + 10, 24, col.fg));
    if (d.vendor !== "Generic") {
      const vw = d.vendor.length * 5.6 + 6;
      out.push(
        `<rect x="${r1(tx + 44 + 12 - vw)}" y="${ty - 8}" width="${r1(vw)}" height="12" rx="2" fill="${col.raised}" stroke="${col.border}"/>`,
      );
      out.push(
        text(tx + 44 + 12 - vw / 2, ty + 1, d.vendor.toUpperCase(), {
          size: 8,
          weight: 600,
          color: col.muted,
          anchor: "middle",
        }),
      );
    }
    out.push(
      text(n.x + n.w / 2, n.y + 64, d.hostname, {
        size: 12,
        weight: 500,
        color: col.fg,
        anchor: "middle",
      }),
    );
    const sub = ext ? `↗ ${n.sub ?? ""}` : d.mgmtIp;
    if (sub)
      out.push(
        text(n.x + n.w / 2, n.y + 78, sub, {
          size: 10,
          color: col.muted,
          anchor: "middle",
          mono: true,
        }),
      );
    out.push(`</g>`);
  }
  out.push(...labels, "</g>");

  if (legendItems.length) {
    let x = PAD;
    const y = height - PAD + 4;
    for (const item of legendItems) {
      const color = resolveColor(item.color, input.theme);
      out.push(
        `<line x1="${x}" y1="${y - 4}" x2="${x + 18}" y2="${y - 4}" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`,
      );
      out.push(text(x + 24, y, item.label, { size: 11, color: col.muted }));
      x += 24 + item.label.length * 6.2 + 20;
    }
  }
  out.push("</svg>");
  return out.join("\n");
}

/** Bytes as a `data:` URL for embedding (no fetch: CSP allows only IPC connections). */
export async function toDataUrl(bytes: Uint8Array, mime: string): Promise<string> {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the floor plan."));
    reader.readAsDataURL(blob);
  });
}
