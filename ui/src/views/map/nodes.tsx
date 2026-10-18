import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { Copy, Globe, Lock, Pencil, PlugZap, Radar, Route, Server, Unlock } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/Menu";
import { cn } from "@/lib/cn";
import type { Device } from "@/lib/ipc";
import { Glyph } from "@/map/Glyph";
import { DEVICE_SIZE, DEVICE_TILE } from "@/map/model";
import { canOpen, connect, copyIp, methodLabel } from "@/views/inventory/deviceActions";
import { usesLegacySsh } from "@/views/inventory/model";
import { ping, showInInventory, traceroute } from "./nodeActions";
import { useMapUi } from "./mapUi";
import type { BandNode, BuildingNode, DeviceNode, PlanNode, ZoneNode } from "./types";

const HOVER_DELAY = 450;

/** Show `card` after hovering for a moment (minimal hover card). */
function useHover(): [boolean, { onMouseEnter: () => void; onMouseLeave: () => void }] {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [
    shown,
    {
      onMouseEnter: () => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setShown(true), HOVER_DELAY);
      },
      onMouseLeave: () => {
        clearTimeout(timer.current);
        setShown(false);
      },
    },
  ];
}

function HoverCard({ children }: { children: ReactNode }) {
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute top-full left-1/2 z-50 mt-2 w-56 -translate-x-1/2 rounded-lg border border-border bg-surface-raised p-2.5 text-left text-xs shadow-md animate-pop-in"
    >
      {children}
    </div>
  );
}

/** Connection handle; any handle can start or end a link (loose connection mode). */
function LinkHandle() {
  return (
    <Handle
      type="source"
      position={Position.Right}
      // On the icon tile's right edge (the node box is wider than the tile).
      style={{ top: 4 + DEVICE_TILE / 2, right: (DEVICE_SIZE.w - DEVICE_TILE) / 2 }}
      className="!size-2.5 !border-2 !border-surface !bg-accent opacity-0 transition-opacity duration-150 group-hover:opacity-100"
    />
  );
}

export function DeviceNodeView({ data, selected }: NodeProps<DeviceNode>) {
  const d: Device = data.device;
  const [hover, hoverProps] = useHover();
  const setLocked = useMapUi((s) => s.setNodeLocked);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          {...hoverProps}
          className={cn(
            "group relative flex h-[84px] w-[136px] flex-col items-center gap-1 pt-1 text-center",
            data.external && "opacity-60",
          )}
        >
          <div
            className={cn(
              "relative flex size-11 items-center justify-center rounded-lg border bg-surface text-fg shadow-sm transition-colors duration-150",
              data.external ? "border-dashed border-border-strong" : "border-border",
              selected && "border-accent ring-2 ring-accent/40",
            )}
          >
            <Glyph type={d.deviceType} size={24} />
            {d.vendor !== "Generic" && (
              <span className="absolute -top-2 -right-3 rounded-sm bg-surface-raised px-1 text-[9px] font-medium tracking-wide text-fg-muted uppercase ring-1 ring-border">
                {d.vendor}
              </span>
            )}
            {data.locked && (
              <Lock size={10} className="absolute -bottom-1 -left-1 text-fg-subtle" />
            )}
          </div>
          <span className="max-w-full truncate px-1 text-[12px] leading-tight font-medium">
            {d.hostname}
          </span>
          <span className="max-w-full truncate px-1 font-mono text-[10px] leading-tight text-fg-muted">
            {data.external ? `↗ ${data.where}` : d.mgmtIp}
          </span>
          <LinkHandle />
          {hover && (
            <HoverCard>
              <p className="font-medium">{d.hostname}</p>
              {d.mgmtIp && <p className="font-mono text-fg-muted">{d.mgmtIp}</p>}
              <p className="text-fg-muted">{[d.vendor, d.model].filter(Boolean).join(" ")}</p>
              {data.where && <p className="text-fg-muted">{data.where}</p>}
              {usesLegacySsh(d) && <p className="text-warning">Legacy SSH algorithms</p>}
            </HoverCard>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {d.connections.map((m, i) => (
          <ContextMenuItem
            key={i}
            icon={m.kind === "web" ? <Globe size={14} /> : <PlugZap size={14} />}
            disabled={!canOpen(m)}
            onSelect={() => connect(d, i)}
          >
            {methodLabel(m)}
          </ContextMenuItem>
        ))}
        {d.connections.length > 0 && <ContextMenuSeparator />}
        <ContextMenuItem icon={<Radar size={14} />} onSelect={() => ping(d)}>
          Ping
        </ContextMenuItem>
        <ContextMenuItem icon={<Route size={14} />} onSelect={() => traceroute(d)}>
          Traceroute
        </ContextMenuItem>
        <ContextMenuItem
          icon={<Copy size={14} />}
          disabled={!d.mgmtIp}
          onSelect={() => void copyIp(d)}
        >
          Copy IP
        </ContextMenuItem>
        <ContextMenuSeparator />
        {!data.external && (
          <ContextMenuItem
            icon={data.locked ? <Unlock size={14} /> : <Lock size={14} />}
            onSelect={() => setLocked(`d:${d.id}`, !data.locked)}
          >
            {data.locked ? "Unlock position" : "Lock position"}
          </ContextMenuItem>
        )}
        <ContextMenuItem icon={<Pencil size={14} />} onSelect={() => showInInventory(d, true)}>
          Edit
        </ContextMenuItem>
        <ContextMenuItem icon={<Server size={14} />} onSelect={() => showInInventory(d)}>
          Show in inventory
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function BuildingNodeView({ data, selected }: NodeProps<BuildingNode>) {
  const b = data.building;
  return (
    <div
      className={cn(
        "group relative flex h-[112px] w-[200px] flex-col justify-between rounded-xl border bg-surface p-3 shadow-sm transition-colors duration-150",
        selected ? "border-accent ring-2 ring-accent/40" : "border-border",
      )}
    >
      <div className="flex items-center gap-2">
        <Glyph type="building" size={22} className="text-fg-muted" />
        <span className="truncate text-[13px] font-semibold">{b.name}</span>
        {b.code && <span className="text-xs text-fg-subtle">{b.code}</span>}
        {data.locked && <Lock size={10} className="ml-auto text-fg-subtle" />}
      </div>
      <p className="text-xs text-fg-muted">
        {data.floors} {data.floors === 1 ? "floor" : "floors"} · {data.devices}{" "}
        {data.devices === 1 ? "device" : "devices"}
      </p>
      <p className="text-[11px] text-fg-subtle">Double-click to open</p>
      <LinkHandle />
    </div>
  );
}

export function ZoneNodeView({ data, selected }: NodeProps<ZoneNode>) {
  const z = data.zone;
  const color = z.color || "var(--fg-subtle)";
  return (
    <>
      <NodeResizer
        isVisible={selected && !z.locked}
        minWidth={80}
        minHeight={60}
        lineClassName="!border-accent"
        handleClassName="!size-2 !rounded-sm !border-accent !bg-surface"
        onResizeEnd={(_, p) =>
          void useMapUi
            .getState()
            .resizeZone(z, { x: p.x, y: p.y, width: p.width, height: p.height })
        }
      />
      <div
        className="size-full rounded-xl border-2 border-dashed"
        style={{
          borderColor: color,
          background: `color-mix(in srgb, ${color} 7%, transparent)`,
        }}
      >
        <span
          className="absolute top-1.5 left-2.5 flex items-center gap-1 text-xs font-semibold"
          style={{ color }}
        >
          {z.name}
          {z.locked && <Lock size={10} />}
        </span>
      </div>
    </>
  );
}

export function BandNodeView({ data }: NodeProps<BandNode>) {
  return (
    <div
      className="rounded-xl border border-border bg-surface-raised/40"
      style={{ width: data.width, height: data.height }}
    >
      <span className="absolute top-1.5 left-3 text-xs font-semibold text-fg-muted">
        {data.label}
      </span>
    </div>
  );
}

export function PlanNodeView({ data }: NodeProps<PlanNode>) {
  return (
    <img
      src={data.url}
      alt=""
      draggable={false}
      style={{ width: data.width, height: data.height, opacity: data.opacity }}
      className="pointer-events-none max-w-none select-none"
    />
  );
}
