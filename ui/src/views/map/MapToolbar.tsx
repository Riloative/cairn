import {
  ChevronRight,
  Download,
  Image,
  LayoutGrid,
  Lock,
  Redo2,
  Rows3,
  SlidersHorizontal,
  SquareDashed,
  Undo2,
  Unlock,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/Menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import type { ColorBy, InventorySnapshot, MapPrefs } from "@/lib/ipc";
import { breadcrumbs, viewKey, type MapViewRef } from "@/map/model";
import { useMap } from "@/stores/map";
import { MapSearch } from "./MapSearch";
import { useMapUi } from "./mapUi";

const COLOR_BY: readonly { value: ColorBy; label: string }[] = [
  { value: "media", label: "Media" },
  { value: "speed", label: "Speed" },
  { value: "vlan", label: "VLAN" },
];

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-[13px]">
      {label}
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}

function ViewOptions({ prefs }: { prefs: MapPrefs }) {
  const setPrefs = useMap((s) => s.setPrefs);
  const set = (p: Partial<MapPrefs>) => void setPrefs({ ...prefs, ...p });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost">
          <SlidersHorizontal size={14} /> View
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-64 flex-col gap-3 p-3">
        <p className="text-xs font-medium text-fg-muted">Link labels (all links)</p>
        <Toggle
          label="Port names"
          checked={prefs.labels.ports}
          onChange={(v) => set({ labels: { ...prefs.labels, ports: v } })}
        />
        <Toggle
          label="Speed"
          checked={prefs.labels.speed}
          onChange={(v) => set({ labels: { ...prefs.labels, speed: v } })}
        />
        <Toggle
          label="VLANs"
          checked={prefs.labels.vlans}
          onChange={(v) => set({ labels: { ...prefs.labels, vlans: v } })}
        />
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-fg-muted">Color links by</span>
          <SegmentedControl
            label="Color links by"
            value={prefs.colorBy}
            options={COLOR_BY}
            onChange={(v) => set({ colorBy: v })}
          />
        </div>
        <Toggle
          label="Snap to grid"
          checked={prefs.snapToGrid}
          onChange={(v) => set({ snapToGrid: v })}
        />
        <Toggle
          label="Mini-map"
          checked={prefs.showMinimap}
          onChange={(v) => set({ showMinimap: v })}
        />
      </PopoverContent>
    </Popover>
  );
}

export function MapToolbar({
  view,
  inv,
  prefs,
}: {
  view: MapViewRef;
  inv: InventorySnapshot;
  prefs: MapPrefs;
}) {
  const setView = useMap((s) => s.setView);
  const locked = useMap((s) => s.layoutLocked);
  const setLocked = useMap((s) => s.setLayoutLocked);
  const canUndo = useMap((s) => s.past.length > 0);
  const canRedo = useMap((s) => s.future.length > 0);
  const undo = useMap((s) => s.undo);
  const redo = useMap((s) => s.redo);
  const ui = useMapUi.getState;
  const crumbs = breadcrumbs(view, inv);
  const key = viewKey(view);
  const floors =
    view.kind === "building"
      ? inv.floors.filter((f) => f.buildingId === view.id).sort((a, b) => b.level - a.level)
      : [];
  const floorId = view.kind === "floor" ? view.id : null;
  const racks = floorId !== null ? inv.racks.filter((r) => r.floorId === floorId) : [];

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
      <nav aria-label="Map location" className="flex min-w-0 items-center gap-1 text-[13px]">
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <ChevronRight size={12} className="text-fg-subtle" />}
            <button
              type="button"
              aria-current={i === crumbs.length - 1 ? "page" : undefined}
              onClick={() => setView(c.view)}
              className={cn(
                "rounded px-1.5 py-0.5 hover:bg-surface-raised",
                i === crumbs.length - 1 ? "font-semibold" : "text-fg-muted",
              )}
            >
              {c.label}
            </button>
          </span>
        ))}
        {floors.length > 0 && (
          <span className="ml-2 flex items-center gap-1">
            {floors.map((f) => (
              <Button
                key={f.id}
                size="sm"
                variant="ghost"
                onClick={() => setView({ kind: "floor", id: f.id })}
              >
                {f.name}
              </Button>
            ))}
          </span>
        )}
      </nav>
      <span className="flex-1" />
      {view.kind !== "rack" && <MapSearch inv={inv} />}
      {view.kind !== "rack" && (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" disabled={locked}>
                <LayoutGrid size={14} /> Layout
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => ui().requestLayout("all")}>
                Auto-layout all
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => ui().requestLayout("selection")}>
                Auto-layout selection
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <ViewOptions prefs={prefs} />
          <Tooltip label="Add zone">
            <Button
              size="sm"
              variant="ghost"
              aria-label="Add zone"
              disabled={locked || !key}
              onClick={() =>
                key &&
                ui().setZoneDialog({
                  id: 0,
                  view: key,
                  name: "",
                  color: "",
                  x: 0,
                  y: -240,
                  width: 320,
                  height: 200,
                  locked: false,
                })
              }
            >
              <SquareDashed size={14} />
            </Button>
          </Tooltip>
          <Tooltip label={locked ? "Unlock layout" : "Lock layout"}>
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={locked}
              aria-label={locked ? "Unlock layout" : "Lock layout"}
              onClick={() => setLocked(!locked)}
              className={cn(locked && "bg-accent-subtle text-fg")}
            >
              {locked ? <Lock size={14} /> : <Unlock size={14} />}
            </Button>
          </Tooltip>
          <Tooltip label="Undo" shortcut="Mod+Z">
            <Button
              size="sm"
              variant="ghost"
              aria-label="Undo"
              disabled={!canUndo}
              onClick={() => void undo()}
            >
              <Undo2 size={14} />
            </Button>
          </Tooltip>
          <Tooltip label="Redo" shortcut="Mod+Shift+Z">
            <Button
              size="sm"
              variant="ghost"
              aria-label="Redo"
              disabled={!canRedo}
              onClick={() => void redo()}
            >
              <Redo2 size={14} />
            </Button>
          </Tooltip>
        </>
      )}
      {floorId !== null && (
        <>
          <Tooltip label="Floor plan">
            <Button
              size="sm"
              variant="ghost"
              aria-label="Floor plan"
              onClick={() => ui().setPlanOpen(true)}
            >
              <Image size={14} />
            </Button>
          </Tooltip>
          <Tooltip label={racks.length ? "Rack elevations" : "No racks on this floor"}>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Rack elevations"
              disabled={racks.length === 0}
              onClick={() => setView({ kind: "rack", floorId })}
            >
              <Rows3 size={14} />
            </Button>
          </Tooltip>
        </>
      )}
      {view.kind !== "rack" && (
        <Button size="sm" variant="secondary" onClick={() => ui().setExportOpen(true)}>
          <Download size={14} /> Export
        </Button>
      )}
    </div>
  );
}
