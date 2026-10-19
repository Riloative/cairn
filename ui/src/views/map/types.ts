import type { Edge, Node } from "@xyflow/react";
import type { Building, Device, Link, Zone } from "@/lib/ipc";
import type { Route } from "@/map/geometry";

export interface DeviceNodeData extends Record<string, unknown> {
  device: Device;
  external: boolean;
  locked: boolean;
  /** Where an external peer lives (building / floor), shown as a subtitle. */
  where: string;
}

export interface BuildingNodeData extends Record<string, unknown> {
  building: Building;
  floors: number;
  devices: number;
  locked: boolean;
}

export interface ZoneNodeData extends Record<string, unknown> {
  zone: Zone;
}

export interface BandNodeData extends Record<string, unknown> {
  label: string;
  floorId: number | null;
  width: number;
  height: number;
}

export interface PlanNodeData extends Record<string, unknown> {
  url: string;
  width: number;
  height: number;
  opacity: number;
}

export type DeviceNode = Node<DeviceNodeData, "device">;
export type BuildingNode = Node<BuildingNodeData, "building">;
export type ZoneNode = Node<ZoneNodeData, "zone">;
export type BandNode = Node<BandNodeData, "band">;
export type PlanNode = Node<PlanNodeData, "plan">;
export type MapNode = DeviceNode | BuildingNode | ZoneNode | BandNode | PlanNode;

export interface LinkEdgeData extends Record<string, unknown> {
  links: Link[];
  /** Computed for all links of the view at once (see `map/routing.ts`). */
  route: Route | null;
  /** Bundle marker, drawn by the first member of a LAG. */
  lag: { cx: number; cy: number; rx: number; ry: number } | null;
}

export type LinkEdge = Edge<LinkEdgeData, "link">;
