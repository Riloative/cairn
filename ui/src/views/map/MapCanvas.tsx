import "@xyflow/react/dist/base.css";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  SelectionMode,
  useReactFlow,
  ViewportPortal,
  type Connection,
  type NodeChange,
  type OnConnectEnd,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { InventorySnapshot, MapPosition, MapSnapshot, Zone } from "@/lib/ipc";
import { lagMarker, type Route } from "@/map/geometry";
import { alignmentGuides } from "@/map/guides";
import { autoLayout, rank } from "@/map/layout";
import {
  BUILDING_SIZE,
  buildView,
  DEVICE_SIZE,
  lagBundles,
  placeNew,
  tileRect,
  type MapViewRef,
  type NodeModel,
  type ViewModel,
} from "@/map/model";
import { routeAll, type RouteNode } from "@/map/routing";
import { useMap, type HistoryEntry } from "@/stores/map";
import { useNotifications } from "@/stores/notifications";
import { connect } from "@/views/inventory/deviceActions";
import { CanvasMenu, type CanvasMenuState } from "./CanvasMenu";
import { SelectionBar } from "./SelectionBar";
import { useMapUi } from "./mapUi";
import { EDGE_TYPES, NODE_TYPES } from "./flowTypes";
import { locate, whereLabel } from "./navigation";
import type { LinkEdge, MapNode } from "./types";

const BAND_PAD = 28;

/** Fit the whole view without blowing small maps up past a readable size. */
const FIT = { padding: 0.15, maxZoom: 1.2 };

function edgeList(model: ViewModel, routes: Map<string, Route>): LinkEdge[] {
  const bundles = lagBundles(model.edges);
  return model.edges.map((e) => {
    const members = bundles.get(e.key);
    const first = routes.get(e.key);
    const last = members && routes.get(members[members.length - 1] as string);
    return {
      id: e.key,
      source: e.source,
      target: e.target,
      type: "link",
      data: {
        links: e.links,
        route: first ?? null,
        lag: first && last ? lagMarker(first, last) : null,
      },
    };
  });
}

/** Device and building boxes (fixed sizes, as exported) for routing. */
function routeNodes(nodes: readonly MapNode[]): RouteNode[] {
  const out: RouteNode[] = [];
  for (const n of nodes) {
    if (n.type !== "device" && n.type !== "building") continue;
    const size = n.type === "device" ? DEVICE_SIZE : BUILDING_SIZE;
    const rect = { x: n.position.x, y: n.position.y, w: size.w, h: size.h };
    out.push({ key: n.id, rect, tile: n.type === "device" ? tileRect(rect) : undefined });
  }
  return out;
}

function deviceNodes(model: ViewModel, inv: InventorySnapshot, locked: boolean): MapNode[] {
  const out: MapNode[] = [];
  for (const n of model.nodes) {
    const draggable = !locked && !n.locked && n.kind !== "external";
    if (n.kind === "building") {
      const b = inv.buildings.find((x) => x.id === n.buildingId);
      if (!b) continue;
      out.push({
        id: n.key,
        type: "building",
        position: { x: n.x, y: n.y },
        width: n.w,
        height: n.h,
        draggable: !locked && !n.locked,
        data: {
          building: b,
          floors: inv.floors.filter((f) => f.buildingId === b.id).length,
          devices: inv.devices.filter((d) => d.buildingId === b.id).length,
          locked: n.locked,
        },
      });
      continue;
    }
    const d = inv.devices.find((x) => x.id === n.deviceId);
    if (!d) continue;
    out.push({
      id: n.key,
      type: "device",
      position: { x: n.x, y: n.y },
      width: n.w,
      height: n.h,
      draggable,
      data: {
        device: d,
        external: n.kind === "external",
        locked: n.locked,
        where: n.kind === "external" ? whereLabel(d, inv) : "",
      },
    });
  }
  return out;
}

function zoneNodes(zones: readonly Zone[], locked: boolean): MapNode[] {
  return zones.map((z) => ({
    id: `z:${z.id}`,
    type: "zone" as const,
    position: { x: z.x, y: z.y },
    width: z.width,
    height: z.height,
    zIndex: -1,
    draggable: !locked && !z.locked,
    data: { zone: z },
  }));
}

/** Building view: one band per floor around its devices (drawn behind them). */
function bandNodes(
  ref: MapViewRef,
  model: ViewModel,
  nodes: readonly MapNode[],
  inv: InventorySnapshot,
): MapNode[] {
  if (ref.kind !== "building") return [];
  const byFloor = new Map<number | null, MapNode[]>();
  for (const m of model.nodes) {
    if (m.kind !== "device") continue;
    const node = nodes.find((x) => x.id === m.key);
    if (!node) continue;
    const k = m.band ?? null;
    byFloor.set(k, [...(byFloor.get(k) ?? []), node]);
  }
  const out: MapNode[] = [];
  for (const [floorId, members] of byFloor) {
    const xs = members.map((n) => n.position.x);
    const ys = members.map((n) => n.position.y);
    const x2 = Math.max(...members.map((n) => n.position.x + (n.width ?? 0)));
    const y2 = Math.max(...members.map((n) => n.position.y + (n.height ?? 0)));
    const x = Math.min(...xs) - BAND_PAD;
    const y = Math.min(...ys) - BAND_PAD - 8;
    const label =
      floorId === null ? "No floor" : (inv.floors.find((f) => f.id === floorId)?.name ?? "Floor");
    out.push({
      id: `band:${floorId ?? "none"}`,
      type: "band",
      position: { x, y },
      zIndex: -2,
      draggable: false,
      selectable: false,
      focusable: false,
      data: { label, floorId, width: x2 - x + BAND_PAD, height: y2 - y + BAND_PAD },
    });
  }
  return out;
}

const posOf = (view: string, n: MapNode): MapPosition => ({
  view,
  node: n.id,
  x: Math.round(n.position.x),
  y: Math.round(n.position.y),
  locked: n.type === "device" || n.type === "building" ? Boolean(n.data.locked) : false,
});

const isLayoutNode = (n: MapNode) =>
  (n.type === "device" && !n.data.external) || n.type === "building";

/** Device/building nodes fully inside a zone (they move with it). */
function contained(zone: MapNode, nodes: readonly MapNode[]): MapNode[] {
  const zx = zone.position.x,
    zy = zone.position.y,
    zw = zone.width ?? 0,
    zh = zone.height ?? 0;
  return nodes.filter(
    (n) =>
      isLayoutNode(n) &&
      n.draggable !== false &&
      n.position.x >= zx &&
      n.position.y >= zy &&
      n.position.x + (n.width ?? 0) <= zx + zw &&
      n.position.y + (n.height ?? 0) <= zy + zh,
  );
}

export function MapCanvas({
  view,
  inv,
  map,
  planUrl,
}: {
  view: MapViewRef;
  inv: InventorySnapshot;
  map: MapSnapshot;
  planUrl: string | null;
}) {
  const flow = useReactFlow<MapNode, LinkEdge>();
  const locked = useMap((s) => s.layoutLocked);
  const savePositions = useMap((s) => s.savePositions);
  const setView = useMap((s) => s.setView);
  const focus = useMapUi((s) => s.focus);
  const prefs = map.prefs;
  const model = useMemo(() => buildView(view, inv, map), [view, inv, map]);
  const plan =
    view.kind === "floor" ? map.floorPlans.find((p) => p.floorId === view.id) : undefined;

  const [nodes, setNodes] = useState<MapNode[]>([]);
  const [guides, setGuides] = useState<{ vertical: number | null; horizontal: number | null }>({
    vertical: null,
    horizontal: null,
  });
  const [menu, setMenu] = useState<CanvasMenuState | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  // A first layout of a big view takes a moment (in a worker); say so.
  const [arranging, setArranging] = useState(false);
  const dragging = useRef(false);
  const dragStart = useRef<{
    positions: MapPosition[];
    zone: Zone | null;
    members: MapNode[];
  } | null>(null);

  // Rebuild nodes from the model unless a drag is in progress.
  useEffect(() => {
    if (dragging.current) return;
    const base = [...zoneNodes(model.zones, locked), ...deviceNodes(model, inv, locked)];
    const selected = new Set(selection);
    const withSel = base.map((n) => (selected.has(n.id) ? { ...n, selected: true } : n));
    const planNode: MapNode[] =
      plan && planUrl
        ? [
            {
              id: "plan",
              type: "plan",
              position: { x: plan.x, y: plan.y },
              zIndex: -3,
              draggable: false,
              selectable: false,
              focusable: false,
              data: {
                url: planUrl,
                width: plan.width * plan.scale,
                height: plan.height * plan.scale,
                opacity: plan.opacity,
              },
            },
          ]
        : [];
    setNodes([...planNode, ...bandNodes(view, model, withSel, inv), ...withSel]);
    // `selection` is read, not tracked: selection changes come from React Flow itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, inv, locked, plan, planUrl, view]);

  const layerFor = useCallback(
    (n: NodeModel) => {
      if (view.kind !== "building") return rank(n, inv);
      // Building view: one layer band per floor, top floor first.
      const d = inv.devices.find((x) => x.id === n.deviceId);
      const floors = inv.floors
        .filter((f) => f.buildingId === view.id)
        .sort((a, b) => b.level - a.level);
      const i = floors.findIndex((f) => f.id === d?.floorId);
      return i < 0 ? floors.length : i;
    },
    [view, inv],
  );

  // Unplaced nodes: lay out everything on a fresh view, else add newcomers below.
  const laying = useRef(false);
  useEffect(() => {
    const unplaced = model.nodes.filter((n) => !n.placed);
    if (unplaced.length === 0 || laying.current || !model.key) return;
    laying.current = true;
    const placedAny = model.nodes.some((n) => n.placed);
    const run = async () => {
      let positioned: NodeModel[];
      if (!placedAny) {
        setArranging(true);
        const result = await autoLayout(
          model.nodes,
          model.edges,
          (n) => layerFor(n),
          { x: 0, y: 0 },
          prefs.gridSize,
        );
        positioned = model.nodes.map((n) => ({ ...n, ...(result.get(n.key) ?? {}) }));
      } else {
        positioned = placeNew(model.nodes, prefs.gridSize);
      }
      await savePositions(
        positioned
          .filter((n) => !n.placed)
          .map((n) => ({ view: model.key, node: n.key, x: n.x, y: n.y, locked: false })),
      );
      // A freshly laid-out view: show all of it once the new positions are rendered.
      if (!placedAny) requestAnimationFrame(() => void flow.fitView(FIT));
    };
    run()
      .catch((e: unknown) =>
        useNotifications.getState().notifyError(e, "Could not lay out the map"),
      )
      .finally(() => {
        laying.current = false;
        setArranging(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  // Focus a device requested by search once it is on screen.
  useEffect(() => {
    if (focus === null) return;
    const id = `d:${focus}`;
    if (!nodes.some((n) => n.id === id)) return;
    useMapUi.getState().setFocus(null);
    flow.setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
    void flow.fitView({ nodes: [{ id }], duration: 300, maxZoom: 1.25, padding: 0.4 });
  }, [focus, nodes, flow]);

  const onNodesChange = useCallback((changes: NodeChange<MapNode>[]) => {
    setNodes((current) => {
      let next = applyNodeChanges(changes, current);
      const moving = changes.filter((c) => c.type === "position" && c.dragging);
      // Alignment guides for a single dragged device/building.
      if (moving.length === 1 && moving[0]?.type === "position") {
        const id = moving[0].id;
        const node = next.find((n) => n.id === id);
        if (node && isLayoutNode(node)) {
          const rect = {
            x: node.position.x,
            y: node.position.y,
            w: node.width ?? 0,
            h: node.height ?? 0,
          };
          const others = next
            .filter((n) => n.id !== id && isLayoutNode(n))
            .map((n) => ({ x: n.position.x, y: n.position.y, w: n.width ?? 0, h: n.height ?? 0 }));
          const g = alignmentGuides(rect, others);
          setGuides({ vertical: g.vertical, horizontal: g.horizontal });
          next = next.map((n) => (n.id === id ? { ...n, position: { x: g.x, y: g.y } } : n));
        }
        // Zones carry the nodes inside them.
        if (node?.type === "zone" && dragStart.current?.zone) {
          const dx = node.position.x - dragStart.current.zone.x;
          const dy = node.position.y - dragStart.current.zone.y;
          const start = new Map(dragStart.current.members.map((m) => [m.id, m.position]));
          next = next.map((n) => {
            const p = start.get(n.id);
            return p ? { ...n, position: { x: p.x + dx, y: p.y + dy } } : n;
          });
        }
      }
      return next;
    });
  }, []);

  const onNodeDragStart = useCallback(
    (_: unknown, node: MapNode, dragged: MapNode[]) => {
      dragging.current = true;
      const zone = node.type === "zone" ? node.data.zone : null;
      const members = node.type === "zone" ? contained(node, nodes) : [];
      dragStart.current = {
        positions: [...dragged, ...members].filter(isLayoutNode).map((n) => posOf(model.key, n)),
        zone,
        members,
      };
    },
    [nodes, model.key],
  );

  const onNodeDragStop = useCallback(
    (_: unknown, node: MapNode, dragged: MapNode[]) => {
      dragging.current = false;
      setGuides({ vertical: null, horizontal: null });
      const start = dragStart.current;
      dragStart.current = null;
      if (!start) return;
      const live = flow.getNodes();
      const latest = (id: string) => live.find((n) => n.id === id);
      const movedIds = new Set([...dragged.map((n) => n.id), ...start.members.map((m) => m.id)]);
      const after = [...movedIds]
        .map(latest)
        .filter((n): n is MapNode => Boolean(n) && isLayoutNode(n as MapNode))
        .map((n) => posOf(model.key, n));
      const entries: HistoryEntry[] = [];
      if (after.length) {
        void savePositions(after);
        entries.push({ kind: "positions", before: start.positions, after });
      }
      const zoneMoves = dragged.filter((n) => n.type === "zone");
      void (async () => {
        for (const z of zoneMoves) {
          if (z.type !== "zone") continue;
          const before = z.data.zone;
          const current = latest(z.id) ?? z;
          const saved = await useMap
            .getState()
            .saveZone(
              { ...before, x: Math.round(current.position.x), y: Math.round(current.position.y) },
              false,
            );
          if (saved) entries.push({ kind: "zone", before, after: saved });
        }
        if (entries.length) useMap.getState().pushHistory({ kind: "batch", entries });
      })();
      void node;
    },
    [flow, model.key, savePositions],
  );

  const onConnect = useCallback((c: Connection) => {
    const a = c.source?.startsWith("d:") ? Number(c.source.slice(2)) : null;
    const b = c.target?.startsWith("d:") ? Number(c.target.slice(2)) : null;
    if (a === null || b === null || a === b) {
      useNotifications.getState().notify({
        variant: "info",
        title: "Links connect two devices",
        description: "Drag from a device to another device. Open a building to link its devices.",
      });
      return;
    }
    useMapUi.getState().setLinkDialog({ mode: "new", aDeviceId: a, bDeviceId: b });
  }, []);

  // Dropping a new link anywhere on a device (not only on its handle) connects to it.
  const onConnectEnd = useCallback<OnConnectEnd>(
    (event, state) => {
      if (state.isValid || !state.fromNode) return;
      const point = "changedTouches" in event ? event.changedTouches[0] : event;
      if (!point) return;
      const target = document
        .elementFromPoint(point.clientX, point.clientY)
        ?.closest(".react-flow__node")
        ?.getAttribute("data-id");
      if (target && target !== state.fromNode.id)
        onConnect({ source: state.fromNode.id, target, sourceHandle: null, targetHandle: null });
    },
    [onConnect],
  );

  const onNodeDoubleClick = useCallback(
    (_: MouseEvent, node: MapNode) => {
      if (node.type === "building") setView({ kind: "building", id: node.data.building.id });
      else if (node.type === "band" && node.data.floorId !== null)
        setView({ kind: "floor", id: node.data.floorId });
      else if (node.type === "zone") useMapUi.getState().setZoneDialog(node.data.zone);
      else if (node.type === "device") {
        if (node.data.external) {
          const target = locate(node.data.device, inv);
          setView(target);
          useMapUi.getState().setFocus(node.data.device.id);
        } else connect(node.data.device, 0);
      }
    },
    [inv, setView],
  );

  const onSelectionChange = useCallback((p: OnSelectionChangeParams) => {
    setSelection([...p.nodes.map((n) => n.id), ...p.edges.map((e) => e.id)]);
  }, []);

  const routes = useMemo(() => routeAll(routeNodes(nodes), model.edges), [nodes, model.edges]);
  const edges = useMemo(() => edgeList(model, routes), [model, routes]);

  const selectionRef = useRef(selection);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);
  useEffect(() => {
    useMapUi.getState().setCanvas({
      nodes: () => flow.getNodes(),
      selection: () => selectionRef.current,
      model,
    });
    return () => useMapUi.getState().setCanvas(null);
  }, [flow, model]);

  const layoutRequest = useMapUi((s) => s.layoutRequest);
  useEffect(() => {
    if (!layoutRequest) return;
    useMapUi.getState().requestLayout(null);
    void layoutNodes(layoutRequest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutRequest]);

  return (
    <div className="relative size-full" data-map-view={model.key}>
      {arranging && (
        <div
          role="status"
          className="pointer-events-none absolute top-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-surface-raised px-3 py-1 text-xs text-fg-muted shadow-sm animate-fade-in"
        >
          Arranging {model.nodes.length} devices…
        </div>
      )}
      <ReactFlow<MapNode, LinkEdge>
        nodes={nodes}
        edges={edges.map((e) => (selection.includes(e.id) ? { ...e, selected: true } : e))}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onNodeDoubleClick={onNodeDoubleClick}
        onEdgeDoubleClick={(_, e) => {
          const link = e.data?.links[0];
          if (link && e.data?.links.length === 1)
            useMapUi.getState().setLinkDialog({ mode: "edit", link });
        }}
        onEdgeContextMenu={(ev, e) => {
          ev.preventDefault();
          setMenu({ kind: "edge", x: ev.clientX, y: ev.clientY, edge: e });
        }}
        onPaneContextMenu={(ev) => {
          ev.preventDefault();
          const p = flow.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
          setMenu({ kind: "pane", x: ev.clientX, y: ev.clientY, flowX: p.x, flowY: p.y });
        }}
        onSelectionChange={onSelectionChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        connectionMode={ConnectionMode.Loose}
        selectionMode={SelectionMode.Partial}
        selectionOnDrag
        panOnDrag={[1, 2]}
        snapToGrid={prefs.snapToGrid}
        snapGrid={[prefs.gridSize, prefs.gridSize]}
        deleteKeyCode={null}
        multiSelectionKeyCode={["Meta", "Control", "Shift"]}
        nodesDraggable={!locked}
        minZoom={0.1}
        maxZoom={2.5}
        fitView
        fitViewOptions={FIT}
        proOptions={{ hideAttribution: true }}
        className="cairn-map"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={prefs.gridSize}
          size={1}
          color="var(--border-strong)"
        />
        <Controls showInteractive={false} position="bottom-left" fitViewOptions={FIT} />
        {prefs.showMinimap && (
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            nodeColor={(n) =>
              n.type === "zone" || n.type === "band" ? "transparent" : "var(--fg-subtle)"
            }
            maskColor="color-mix(in srgb, var(--bg) 70%, transparent)"
            style={{ background: "var(--surface-raised)" }}
          />
        )}
        <ViewportPortal>
          {guides.vertical !== null && (
            <div
              className="pointer-events-none absolute w-px bg-accent"
              style={{ left: guides.vertical, top: -100_000, height: 200_000 }}
            />
          )}
          {guides.horizontal !== null && (
            <div
              className="pointer-events-none absolute h-px bg-accent"
              style={{ top: guides.horizontal, left: -100_000, width: 200_000 }}
            />
          )}
        </ViewportPortal>
      </ReactFlow>
      <SelectionBar selection={selection} inv={inv} />
      <CanvasMenu
        state={menu}
        onClose={() => setMenu(null)}
        view={view}
        viewKey={model.key}
        selection={selection}
        onLayout={(scope) => void layoutNodes(scope)}
      />
    </div>
  );

  /** Auto-layout everything or just the selected nodes. */
  async function layoutNodes(scope: "all" | "selection") {
    const sel = new Set(selection);
    const targets = model.nodes.filter(
      (n) => n.kind !== "external" && !n.locked && (scope === "all" || sel.has(n.key)),
    );
    if (targets.length < 2) return;
    const current = new Map(nodes.map((n) => [n.id, n.position]));
    const origin = targets.reduce(
      (o, n) => {
        const p = current.get(n.key) ?? { x: n.x, y: n.y };
        return { x: Math.min(o.x, p.x), y: Math.min(o.y, p.y) };
      },
      { x: Infinity, y: Infinity },
    );
    const result = await autoLayout(targets, model.edges, layerFor, origin, prefs.gridSize);
    const before = targets.map((n) => {
      const p = current.get(n.key) ?? { x: n.x, y: n.y };
      return { view: model.key, node: n.key, x: p.x, y: p.y, locked: n.locked };
    });
    const after = targets.map((n) => ({
      view: model.key,
      node: n.key,
      ...(result.get(n.key) ?? { x: n.x, y: n.y }),
      locked: n.locked,
    }));
    await savePositions(after, before);
    if (scope === "all") void flow.fitView({ ...FIT, duration: 300 });
  }
}
