import { LinkEdgeView } from "./LinkEdgeView";
import {
  BandNodeView,
  BuildingNodeView,
  DeviceNodeView,
  PlanNodeView,
  ZoneNodeView,
} from "./nodes";

/** React Flow node and edge renderers (kept stable outside components). */
export const NODE_TYPES = {
  device: DeviceNodeView,
  building: BuildingNodeView,
  zone: ZoneNodeView,
  band: BandNodeView,
  plan: PlanNodeView,
};

export const EDGE_TYPES = { link: LinkEdgeView };
