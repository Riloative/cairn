import { Panel, useReactFlow, useStore, type ReactFlowState } from "@xyflow/react";
import { useRef, type PointerEvent } from "react";
import { shallow } from "zustand/shallow";
import type { Vlan } from "@/lib/ipc";
import { linkColor } from "@/map/colors";
import { useInventory } from "@/stores/inventory";
import { useMap } from "@/stores/map";
import type { LinkEdgeData, MapNode } from "./types";

const W = 208;
const H = 144;
const NO_VLANS: Vlan[] = [];

interface Box {
  id: string;
  type: MapNode["type"];
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  selected: boolean;
  external: boolean;
  color?: string;
}

/** Node boxes in flow coordinates (only what the overview draws). */
function boxesOf(s: ReactFlowState): Box[] {
  const out: Box[] = [];
  for (const n of s.nodeLookup.values()) {
    const node = n as unknown as MapNode & {
      internals: { positionAbsolute: { x: number; y: number } };
    };
    const w = n.measured.width ?? n.width ?? 0;
    const h = n.measured.height ?? n.height ?? 0;
    if (!w || !h || node.type === "plan") continue;
    const { x, y } = node.internals.positionAbsolute;
    const base = { id: n.id, type: node.type, x, y, w, h, selected: !!n.selected };
    switch (node.type) {
      case "device":
        out.push({ ...base, label: node.data.device.hostname, external: node.data.external });
        break;
      case "building":
        out.push({ ...base, label: node.data.building.name, external: false });
        break;
      case "zone":
        out.push({
          ...base,
          label: node.data.zone.name,
          external: false,
          color: node.data.zone.color,
        });
        break;
      case "band":
        out.push({ ...base, label: node.data.label, external: false });
        break;
    }
  }
  return out;
}

function boxesEqual(a: Box[], b: Box[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i];
      return (
        !!y &&
        x.id === y.id &&
        x.x === y.x &&
        x.y === y.y &&
        x.w === y.w &&
        x.h === y.h &&
        x.selected === y.selected &&
        x.label === y.label
      );
    })
  );
}

interface Line {
  id: string;
  source: string;
  target: string;
  data: LinkEdgeData | undefined;
}

const linesOf = (s: ReactFlowState): Line[] =>
  s.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    data: e.data as LinkEdgeData | undefined,
  }));

const linesEqual = (a: Line[], b: Line[]) =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i];
    return (
      !!y && x.id === y.id && x.source === y.source && x.target === y.target && x.data === y.data
    );
  });

/**
 * Overview of the whole view in the corner: links in their colours, devices as small
 * blocks, buildings and zones as labelled areas, and the visible part as a frame.
 * Click or drag in it to move the view.
 */
export function Overview() {
  const boxes = useStore(boxesOf, boxesEqual);
  const lines = useStore(linesOf, linesEqual);
  const [tx, ty, zoom] = useStore((s) => s.transform, shallow);
  const vw = useStore((s) => s.width);
  const vh = useStore((s) => s.height);
  const prefs = useMap((s) => s.data?.prefs);
  const vlans = useInventory((s) => s.snapshot?.vlans) ?? NO_VLANS;
  const { setCenter, getZoom } = useReactFlow();
  const dragging = useRef(false);

  if (boxes.length === 0) return null;
  const view = { x: -tx / zoom, y: -ty / zoom, w: vw / zoom, h: vh / zoom };
  // Bounds of the content, plus the visible area so its frame is always inside.
  let minX = view.x;
  let minY = view.y;
  let maxX = view.x + view.w;
  let maxY = view.y + view.h;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  const pad = Math.max(maxX - minX, maxY - minY) * 0.04;
  minX -= pad;
  minY -= pad;
  const spanW = maxX - minX + pad;
  const spanH = maxY - minY + pad;
  // Units per minimap pixel, for strokes and text that should keep a fixed size.
  const unit = Math.max(spanW / W, spanH / H);
  const centre = new Map(boxes.map((b) => [b.id, { x: b.x + b.w / 2, y: b.y + b.h / 2 }]));

  function moveTo(e: PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    // The SVG keeps its aspect ratio centred ("meet"); undo that to get flow coords.
    const scale = Math.max(spanW / r.width, spanH / r.height);
    const offX = (r.width - spanW / scale) / 2;
    const offY = (r.height - spanH / scale) / 2;
    const x = minX + (e.clientX - r.left - offX) * scale;
    const y = minY + (e.clientY - r.top - offY) * scale;
    void setCenter(x, y, { zoom: getZoom() });
  }

  return (
    <Panel position="bottom-right" className="!m-3">
      <svg
        role="img"
        aria-label="Map overview"
        width={W}
        height={H}
        viewBox={`${minX} ${minY} ${spanW} ${spanH}`}
        className="cursor-pointer rounded-lg border border-border bg-surface-raised shadow-md"
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          moveTo(e);
        }}
        onPointerMove={(e) => dragging.current && moveTo(e)}
        onPointerUp={() => (dragging.current = false)}
      >
        {boxes
          .filter((b) => b.type === "zone" || b.type === "band")
          .map((b) => (
            <rect
              key={b.id}
              x={b.x}
              y={b.y}
              width={b.w}
              height={b.h}
              rx={4 * unit}
              fill={b.color ?? "var(--fg-subtle)"}
              fillOpacity={b.type === "zone" ? 0.12 : 0.05}
              stroke={b.color ?? "var(--border-strong)"}
              strokeWidth={unit}
              strokeDasharray={b.type === "band" ? `${3 * unit} ${2 * unit}` : undefined}
            />
          ))}
        {lines.map((l) => {
          const a = centre.get(l.source);
          const b = centre.get(l.target);
          const first = l.data?.links[0];
          if (!a || !b) return null;
          return (
            <line
              key={l.id}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={first && prefs ? linkColor(first, prefs.colorBy, vlans) : "var(--fg-subtle)"}
              strokeOpacity={0.8}
              strokeWidth={(l.data && l.data.links.length > 1 ? 2 : 1.2) * unit}
            />
          );
        })}
        {boxes
          .filter((b) => b.type === "device" || b.type === "building")
          .map((b) =>
            b.type === "building" ? (
              <g key={b.id}>
                <rect
                  x={b.x}
                  y={b.y}
                  width={b.w}
                  height={b.h}
                  rx={4 * unit}
                  fill="var(--surface)"
                  stroke={b.selected ? "var(--accent)" : "var(--fg-muted)"}
                  strokeWidth={1.2 * unit}
                />
                {b.w / unit > 40 && (
                  <text
                    x={b.x + b.w / 2}
                    y={b.y + b.h / 2}
                    fontSize={9 * unit}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="var(--fg-muted)"
                  >
                    {b.label}
                  </text>
                )}
              </g>
            ) : (
              <rect
                key={b.id}
                x={b.x}
                y={b.y}
                width={b.w}
                height={b.h}
                rx={3 * unit}
                fill={
                  b.selected ? "var(--accent)" : b.external ? "var(--surface)" : "var(--fg-muted)"
                }
                stroke={b.selected ? "var(--accent)" : "var(--fg-muted)"}
                strokeWidth={unit}
              />
            ),
          )}
        <rect
          x={view.x}
          y={view.y}
          width={view.w}
          height={view.h}
          fill="var(--accent)"
          fillOpacity={0.06}
          stroke="var(--accent)"
          strokeWidth={1.5 * unit}
          rx={2 * unit}
        />
      </svg>
    </Panel>
  );
}
