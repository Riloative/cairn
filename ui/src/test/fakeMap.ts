import type { FloorPlanInfo, Link, MapPrefs, MapSnapshot, Zone } from "@/lib/ipc";
import type { FakeInventory } from "./fakeInventory";

type Fail = (payload: { code: string; message: string; hint: string | null }) => never;

export const DEFAULT_MAP_PREFS: MapPrefs = {
  labels: { ports: true, speed: false, vlans: false },
  colorBy: "media",
  snapToGrid: true,
  gridSize: 16,
  showMinimap: true,
};

/** In-memory map data mirroring `cairn_core::map` for UI flows. */
export class FakeMap {
  data: MapSnapshot = {
    links: [],
    positions: [],
    zones: [],
    floorPlans: [],
    prefs: structuredClone(DEFAULT_MAP_PREFS),
  };
  /** Plan image bytes by floor id. */
  images = new Map<number, Uint8Array>();
  /** Raw uploads carry the floor in a header the IPC mock cannot see; tests set it here. */
  uploadFloor: number | null = null;
  /** SVG documents handed to `map_export`, newest last. */
  exports: { svg: string; format: string; scale: number; path: string }[] = [];
  private next = 5000;

  constructor(
    private inv: FakeInventory,
    private log: (kind: string, payload?: Record<string, unknown>) => void,
    private fail: Fail,
  ) {}

  private iface(id: number) {
    const i = this.inv.interfaces.find((x) => x.id === id);
    if (!i)
      this.fail({
        code: "inventory.not_found",
        message: "That interface no longer exists.",
        hint: null,
      });
    return i;
  }

  private hostname(deviceId: number) {
    return this.inv.snap.devices.find((d) => d.id === deviceId)?.hostname ?? "?";
  }

  saveLink(link: Link): Link {
    const a = this.iface(link.aInterfaceId);
    const b = this.iface(link.bInterfaceId);
    if (a.deviceId === b.deviceId)
      this.fail({
        code: "map.invalid",
        message: "A link needs two different devices.",
        hint: null,
      });
    const taken = this.data.links.some(
      (l) =>
        l.id !== link.id && [l.aInterfaceId, l.bInterfaceId].some((x) => x === a.id || x === b.id),
    );
    if (taken)
      this.fail({ code: "map.conflict", message: "That interface is already linked.", hint: null });
    const saved: Link = {
      ...link,
      id: link.id || this.next++,
      aDeviceId: a.deviceId,
      bDeviceId: b.deviceId,
      aName: a.name,
      bName: b.name,
    };
    this.data.links = [...this.data.links.filter((l) => l.id !== saved.id), saved];
    this.log("inventory_changed", {
      entity: "link",
      action: link.id ? "updated" : "created",
      name: `${this.hostname(a.deviceId)} ${a.name} ↔ ${this.hostname(b.deviceId)} ${b.name}`,
    });
    return saved;
  }

  handle(cmd: string, args: Record<string, unknown>): { handled: boolean; result?: unknown } {
    const done = (result: unknown = null) => ({ handled: true, result });
    switch (cmd) {
      case "map_snapshot":
        return done(structuredClone(this.data));
      case "link_save":
        return done(this.saveLink(args.link as Link));
      case "link_delete":
        this.data.links = this.data.links.filter((l) => l.id !== args.id);
        this.log("inventory_changed", { entity: "link", action: "deleted" });
        return done();
      case "map_positions_save":
        for (const p of args.positions as MapSnapshot["positions"]) {
          this.data.positions = [
            ...this.data.positions.filter((x) => x.view !== p.view || x.node !== p.node),
            p,
          ];
        }
        return done();
      case "zone_save": {
        const z = args.zone as Zone;
        const saved = { ...z, id: z.id || this.next++ };
        this.data.zones = [...this.data.zones.filter((x) => x.id !== saved.id), saved];
        return done(saved);
      }
      case "zone_delete":
        this.data.zones = this.data.zones.filter((z) => z.id !== args.id);
        return done();
      case "map_prefs_update":
        this.data.prefs = args.prefs as MapPrefs;
        return done(this.data.prefs);
      case "floor_plan_upload": {
        const floorId = this.uploadFloor ?? this.inv.snap.floors[0]?.id ?? 0;
        const bytes = args as unknown as Uint8Array;
        const info: FloorPlanInfo = {
          floorId,
          name: "plan.png",
          mime: "image/png",
          width: 800,
          height: 600,
          scale: 1,
          opacity: 0.6,
          x: 0,
          y: 0,
          bytes: bytes.byteLength ?? 0,
        };
        this.images.set(floorId, bytes);
        this.data.floorPlans = [...this.data.floorPlans.filter((p) => p.floorId !== floorId), info];
        return done(info);
      }
      case "floor_plan_image":
        return done(this.images.get(args.floorId as number)?.buffer ?? new ArrayBuffer(0));
      case "floor_plan_place": {
        const p = this.data.floorPlans.find((x) => x.floorId === args.floorId);
        if (!p)
          return this.fail({ code: "inventory.not_found", message: "No floor plan.", hint: null });
        Object.assign(p, args.placement);
        return done(p);
      }
      case "floor_plan_delete":
        this.data.floorPlans = this.data.floorPlans.filter((p) => p.floorId !== args.floorId);
        this.images.delete(args.floorId as number);
        return done();
      case "map_export": {
        const e = args as unknown as FakeMap["exports"][number];
        this.exports.push(e);
        this.log("data_exported", { what: "map", format: e.format, path: e.path });
        return done(e.path);
      }
      default:
        return { handled: false };
    }
  }
}
