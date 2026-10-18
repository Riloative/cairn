import { ReactFlowProvider } from "@xyflow/react";
import { Network } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useActions } from "@/lib/actions";
import type { InventorySnapshot, MapSnapshot } from "@/lib/ipc";
import { legend } from "@/map/colors";
import { breadcrumbs, buildView, type MapViewRef } from "@/map/model";
import { useInventory } from "@/stores/inventory";
import { useMap } from "@/stores/map";
import { useUi } from "@/stores/ui";
import { ExportDialog } from "./ExportDialog";
import { FloorPlanDialog } from "./FloorPlanDialog";
import { LinkDialog } from "./LinkDialog";
import { MapCanvas } from "./MapCanvas";
import { MapToolbar } from "./MapToolbar";
import { useMapUi } from "./mapUi";
import { RackView } from "./RackView";
import { ZoneDialog } from "./ZoneDialog";

function Legend({
  view,
  inv,
  map,
}: {
  view: MapViewRef;
  inv: InventorySnapshot;
  map: MapSnapshot;
}) {
  const items = useMemo(() => {
    const model = buildView(view, inv, map);
    return legend(
      model.edges.flatMap((e) => e.links),
      map.prefs.colorBy,
      inv.vlans,
    );
  }, [view, inv, map]);
  if (items.length === 0) return null;
  return (
    <ul
      aria-label="Legend"
      className="pointer-events-none absolute top-3 right-3 z-10 flex max-w-64 flex-col gap-1 rounded-lg border border-border bg-surface/90 px-3 py-2 text-xs shadow-sm"
    >
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-2">
          <span aria-hidden className="h-0.5 w-4 rounded-full" style={{ background: i.color }} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/** Undo/redo/lock/export shortcuts while the map is shown. */
function useMapActions() {
  const register = useActions((s) => s.register);
  useEffect(
    () =>
      register([
        {
          id: "map.undo",
          title: "Map: Undo layout change",
          group: "Map",
          shortcut: "Mod+Z",
          scope: "canvas",
          enabled: () => useUi.getState().view === "map" && useMap.getState().past.length > 0,
          run: () => void useMap.getState().undo(),
        },
        {
          id: "map.redo",
          title: "Map: Redo layout change",
          group: "Map",
          shortcut: "Mod+Shift+Z",
          scope: "canvas",
          enabled: () => useUi.getState().view === "map" && useMap.getState().future.length > 0,
          run: () => void useMap.getState().redo(),
        },
        {
          id: "map.layout",
          title: "Map: Auto-layout",
          group: "Map",
          keywords: ["elk", "arrange", "hierarchy"],
          enabled: () => useUi.getState().view === "map" && !useMap.getState().layoutLocked,
          run: () => useMapUi.getState().requestLayout("all"),
        },
        {
          id: "map.lock",
          title: "Map: Lock or unlock layout",
          group: "Map",
          enabled: () => useUi.getState().view === "map",
          run: () => useMap.getState().setLayoutLocked(!useMap.getState().layoutLocked),
        },
        {
          id: "map.export",
          title: "Map: Export (PNG, SVG, PDF)…",
          group: "Map",
          keywords: ["png", "svg", "pdf", "diagram", "print"],
          enabled: () => useUi.getState().view === "map",
          run: () => useMapUi.getState().setExportOpen(true),
        },
      ]),
    [register],
  );
}

export function MapView() {
  const inv = useInventory((s) => s.snapshot);
  const loadInventory = useInventory((s) => s.load);
  const map = useMap((s) => s.data);
  const error = useMap((s) => s.error);
  const load = useMap((s) => s.load);
  const storedView = useMap((s) => s.view);
  const planUrlFor = useMap((s) => s.planUrl);
  const [loadedPlan, setLoadedPlan] = useState<{ key: string; url: string } | null>(null);
  useMapActions();

  useEffect(() => {
    void load();
    void loadInventory();
  }, [load, loadInventory]);

  const view: MapViewRef | null =
    storedView ?? (inv?.sites[0] ? { kind: "campus", siteId: inv.sites[0].id } : null);
  const plan =
    view?.kind === "floor" ? map?.floorPlans.find((p) => p.floorId === view.id) : undefined;
  const planKey = plan ? `${plan.floorId}:${plan.bytes}:${plan.name}` : "";

  useEffect(() => {
    if (!plan) return;
    let alive = true;
    const key = planKey;
    planUrlFor(plan.floorId, plan.mime)
      .then((url) => alive && setLoadedPlan({ key, url }))
      .catch(() => alive && setLoadedPlan(null));
    return () => {
      alive = false;
    };
    // planKey tracks replacement of the image.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, planUrlFor]);
  const planUrl = plan && loadedPlan?.key === planKey ? loadedPlan.url : null;

  if (!inv || !map || !view) {
    return (
      <div className="flex flex-col gap-2 p-4" aria-busy>
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : (
          Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-10" />)
        )}
      </div>
    );
  }

  if (inv.devices.length === 0 && inv.buildings.length === 0) {
    return (
      <EmptyState
        icon={<Network size={20} />}
        title="Nothing to map yet"
        description="Add buildings and devices in the inventory; they appear here, laid out automatically, ready to link interface to interface."
        action={{ label: "Open inventory", onClick: () => useUi.getState().setView("inventory") }}
      />
    );
  }

  const crumbs = breadcrumbs(view, inv);
  const title = crumbs.map((c) => c.label).join(" › ");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MapToolbar view={view} inv={inv} prefs={map.prefs} />
      <div className="relative min-h-0 flex-1">
        {view.kind === "rack" ? (
          <RackView floorId={view.floorId} inv={inv} />
        ) : (
          <ReactFlowProvider key={JSON.stringify(view)}>
            <MapCanvas view={view} inv={inv} map={map} planUrl={planUrl} />
            <Legend view={view} inv={inv} map={map} />
            <ExportDialog view={view} title={title} inv={inv} map={map} />
          </ReactFlowProvider>
        )}
      </div>
      <LinkDialog />
      <ZoneDialog />
      {view.kind === "floor" && <FloorPlanDialog floorId={view.id} plan={plan} />}
    </div>
  );
}
