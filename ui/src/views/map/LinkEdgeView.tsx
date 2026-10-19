import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import type { Vlan } from "@/lib/ipc";
import { linkColor, midText, shownLabels } from "@/map/colors";
import { portLabelAt } from "@/map/geometry";
import { useInventory } from "@/stores/inventory";
import { useMap } from "@/stores/map";
import type { LinkEdge } from "./types";

const NO_VLANS: Vlan[] = [];

function Label({
  x,
  y,
  anchor,
  children,
}: {
  x: number;
  y: number;
  anchor: "start" | "end" | "middle";
  children: string;
}) {
  const shift = anchor === "start" ? "0%" : anchor === "end" ? "-100%" : "-50%";
  return (
    <div
      className="nodrag nopan pointer-events-none absolute rounded-sm bg-surface/85 px-1 font-mono text-[10px] leading-tight whitespace-nowrap text-fg-muted"
      style={{ transform: `translate(${shift}, -50%) translate(${x}px, ${y}px)` }}
    >
      {children}
    </div>
  );
}

export function LinkEdgeView({ id, source, data, selected }: EdgeProps<LinkEdge>) {
  const prefs = useMap((s) => s.data?.prefs);
  const vlans = useInventory((s) => s.snapshot?.vlans) ?? NO_VLANS;
  const r = data?.route;
  const first = data?.links[0];
  if (!data || !r || !first || !prefs) return null;
  const color = linkColor(first, prefs.colorBy, vlans);
  const aggregated = data.links.length > 1;
  const width = aggregated ? 2 + Math.min(3, Math.log2(data.links.length)) : 1.75;
  const shown = shownLabels(first, prefs);
  const mid = midText(data.links, prefs);
  // Port names belong to the end of each device as drawn (a/b may be either node).
  const aIsSource = `d:${first.aDeviceId}` === source;
  const [srcPort, dstPort] = aIsSource ? [first.aName, first.bName] : [first.bName, first.aName];
  const lag = data.lag;

  return (
    <>
      {selected && (
        <path
          d={r.path}
          fill="none"
          stroke="var(--accent)"
          strokeOpacity={0.35}
          strokeWidth={width + 6}
        />
      )}
      <BaseEdge
        id={id}
        path={r.path}
        interactionWidth={14}
        style={{
          stroke: color,
          strokeWidth: width,
          strokeDasharray: first.media === "wireless" ? "5 4" : undefined,
        }}
      />
      {lag && (
        <ellipse
          cx={lag.cx}
          cy={lag.cy}
          rx={lag.rx}
          ry={lag.ry}
          fill="none"
          stroke={color}
          strokeWidth={1.25}
        />
      )}
      <EdgeLabelRenderer>
        {!aggregated && shown.ports && (
          <>
            <Label {...portLabelAt(r.ends[0])}>{srcPort}</Label>
            <Label {...portLabelAt(r.ends[1])}>{dstPort}</Label>
          </>
        )}
        {mid && (
          <Label x={r.mid.x} y={r.mid.y} anchor="middle">
            {mid}
          </Label>
        )}
        {lag && first.lag && (
          <Label x={lag.cx + lag.rx + 4} y={lag.cy - lag.ry} anchor="start">
            {first.lag}
          </Label>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
