import { describe, expect, it } from "vitest";
import type { Device, InventorySnapshot, Link, MapSnapshot, Rack } from "@/lib/ipc";
import { NEW_DEVICE } from "@/views/inventory/model";
import { legend, linkColor, shownLabels, speedMbps } from "./colors";
import { buildSvg, esc } from "./exportSvg";
import { bounds, lagMarker, parallelOffset, portLabelAt, route } from "./geometry";
import { alignmentGuides } from "./guides";
import { autoLayout, deviceRank } from "./layout";
import {
  breadcrumbs,
  buildView,
  lagBundles,
  placeNew,
  tileRect,
  viewKey,
  type NodeModel,
} from "./model";
import { fitPlan } from "./floorplanFile";
import { fits } from "./rack";
import { routeAll } from "./routing";

const device = (id: number, over: Partial<Device> = {}): Device => ({
  ...NEW_DEVICE,
  id,
  hostname: `sw${id}`,
  mgmtIp: `10.0.0.${id}`,
  ...over,
});

const link = (id: number, a: number, b: number, over: Partial<Link> = {}): Link => ({
  id,
  aInterfaceId: id * 10,
  bInterfaceId: id * 10 + 1,
  aDeviceId: a,
  bDeviceId: b,
  aName: `Gi1/0/${id}`,
  bName: `Gi1/0/${id}`,
  media: "copper",
  speed: "",
  vlans: "",
  lag: "",
  description: "",
  labels: { ports: null, speed: null, vlans: null },
  ...over,
});

function inventory(devices: Device[]): InventorySnapshot {
  return {
    sites: [{ id: 1, name: "HQ", notes: "" }],
    buildings: [
      { id: 10, siteId: 1, name: "North", code: "N", address: "", notes: "" },
      { id: 11, siteId: 1, name: "South", code: "S", address: "", notes: "" },
    ],
    floors: [
      { id: 20, buildingId: 10, name: "Ground", level: 0, notes: "" },
      { id: 21, buildingId: 10, name: "First", level: 1, notes: "" },
    ],
    rooms: [],
    racks: [],
    vendors: ["Generic"],
    credentials: [],
    vlans: [
      { id: 1, vid: 10, name: "users", subnet: "", gateway: "", description: "", color: "#112233" },
    ],
    fields: [],
    devices,
    views: [],
  };
}

const emptyMap = (over: Partial<MapSnapshot> = {}): MapSnapshot => ({
  links: [],
  positions: [],
  zones: [],
  floorPlans: [],
  prefs: {
    labels: { ports: true, speed: false, vlans: false },
    colorBy: "media",
    snapToGrid: true,
    gridSize: 16,
    showMinimap: true,
  },
  ...over,
});

describe("geometry", () => {
  const a = { x: 0, y: 0, w: 100, h: 50 };

  it("routes a straight line between aligned boxes", () => {
    const r = route(a, { x: 300, y: 0, w: 100, h: 50 });
    expect(r.points).toEqual([
      { x: 100, y: 25 },
      { x: 300, y: 25 },
    ]);
    expect(r.ends.map((e) => e.side)).toEqual(["right", "left"]);
    expect(r.mid).toEqual({ x: 200, y: 25 });
  });

  it("routes orthogonally with a bend in the middle", () => {
    const r = route(a, { x: 300, y: 200, w: 100, h: 50 });
    expect(r.points).toHaveLength(4);
    for (let i = 1; i < r.points.length; i++) {
      const p = r.points[i - 1]!;
      const q = r.points[i]!;
      expect(p.x === q.x || p.y === q.y).toBe(true);
    }
    expect(r.path.startsWith("M100 25")).toBe(true);
    expect(r.path).toContain("Q");
  });

  it("keeps parallel routes apart", () => {
    const b = { x: 300, y: 200, w: 100, h: 50 };
    const r1 = route(a, b, parallelOffset(0, 2));
    const r2 = route(a, b, parallelOffset(1, 2));
    expect(r1.points[1]!.x).not.toBe(r2.points[1]!.x);
    expect(r1.points[0]!.y).not.toBe(r2.points[0]!.y);
    expect(parallelOffset(1, 3)).toBe(0);
  });

  it("goes vertical when the boxes are stacked", () => {
    const r = route(a, { x: 0, y: 300, w: 100, h: 50 });
    expect(r.ends.map((e) => e.side)).toEqual(["bottom", "top"]);
    expect(portLabelAt(r.ends[1]).anchor).toBe("start");
  });

  it("routes around a node standing in the way", () => {
    // ap and acc-1-2 side by side, acc-1-1 above and to the right of both.
    const ap = { x: 0, y: 200, w: 136, h: 84 };
    const blocker = { x: 200, y: 200, w: 136, h: 84 };
    const target = { x: 400, y: 0, w: 136, h: 84 };
    const direct = route(ap, target);
    const crossesBlocker = (r: ReturnType<typeof route>) =>
      r.points.some(
        (p, i) =>
          i > 0 &&
          Math.max(p.x, r.points[i - 1]!.x) > blocker.x &&
          Math.min(p.x, r.points[i - 1]!.x) < blocker.x + blocker.w &&
          Math.max(p.y, r.points[i - 1]!.y) > blocker.y &&
          Math.min(p.y, r.points[i - 1]!.y) < blocker.y + blocker.h,
      );
    expect(crossesBlocker(direct)).toBe(true);
    const avoided = route(ap, target, 0, { obstacles: [blocker] });
    expect(crossesBlocker(avoided)).toBe(false);
    // Bends in the gap before the blocker rather than switching axis.
    expect(avoided.ends.map((e) => e.side)).toEqual(["right", "left"]);
    expect(avoided.points[1]!.x).toBeLessThan(blocker.x);
    // With no gap on that side, it leaves through the top instead.
    const wall = { ...blocker, x: 140, w: 240 };
    const over = route(ap, target, 0, { obstacles: [wall] });
    expect(over.ends.map((e) => e.side)).toEqual(["top", "bottom"]);
  });

  it("goes around the row when a node sits between two on the same row", () => {
    const left = { x: 0, y: 0, w: 136, h: 84 };
    const middle = { x: 200, y: 0, w: 136, h: 84 };
    const right = { x: 400, y: 0, w: 136, h: 84 };
    const r1 = route(left, right, 0, { obstacles: [middle] });
    expect(r1.ends.map((e) => e.side)).toEqual(["bottom", "bottom"]);
    expect(r1.points[1]!.y).toBeGreaterThan(84);
    // Parallel detours nest instead of crossing, whichever end is the source.
    const inner = route(left, right, -12, { obstacles: [middle] });
    const outer = route(right, left, 12, { obstacles: [middle] });
    expect(outer.points[1]!.y).toBeGreaterThan(inner.points[1]!.y);
    const xs = (r: typeof inner) => [r.points[0]!.x, r.points[3]!.x].sort((p, q) => p - q);
    expect(xs(outer)[0]).toBeLessThan(xs(inner)[0]!);
    expect(xs(outer)[1]).toBeGreaterThan(xs(inner)[1]!);
  });

  it("leaves devices sideways from their icon tile", () => {
    const a = { x: 0, y: 0, w: 136, h: 84 };
    const b = { x: 400, y: 0, w: 136, h: 84 };
    const r = route(a, b, 0, { sideA: tileRect(a), sideB: tileRect(b) });
    expect(r.points[0]).toEqual({ x: 90, y: 26 });
    expect(r.points[1]).toEqual({ x: 446, y: 26 });
  });

  it("computes bounds", () => {
    expect(bounds([])).toBeNull();
    expect(bounds([a, { x: -10, y: 20, w: 10, h: 100 }])).toEqual({ x: -10, y: 0, w: 110, h: 120 });
  });
});

describe("routeAll", () => {
  it("gives links of different peers their own slot on a shared side", () => {
    const box = (key: string, x: number, y: number) => {
      const rect = { x, y, w: 136, h: 84 };
      return { key, rect, tile: tileRect(rect) };
    };
    // Two peers left of `hub`, one above the other: both enter hub from the left.
    const nodes = [box("hub", 600, 100), box("p1", 0, 0), box("p2", 0, 200)];
    const edges = [
      { key: "e1", source: "p1", target: "hub", offset: 0 },
      { key: "e2", source: "p2", target: "hub", offset: 0 },
    ];
    const routes = routeAll(nodes, edges);
    const end1 = routes.get("e1")!.ends[1];
    const end2 = routes.get("e2")!.ends[1];
    expect(end1.side).toBe("left");
    expect(end2.side).toBe("left");
    // Distinct attachment points, ordered like the peers (no crossing near hub).
    expect(end1.y).toBeLessThan(end2.y);
    expect(end2.y - end1.y).toBeGreaterThanOrEqual(16);
  });

  it("fans port labels out on a shared top or bottom side", () => {
    const at = (index: number, count: number) =>
      portLabelAt({ x: 100, y: 50, side: "bottom", slot: { index, count } });
    expect(at(0, 2).anchor).toBe("end");
    expect(at(1, 2).anchor).toBe("start");
    expect(at(1, 3)).toMatchObject({ anchor: "middle", y: 76 });
    expect(portLabelAt({ x: 100, y: 50, side: "bottom" })).toMatchObject({
      anchor: "start",
      y: 64,
    });
  });

  it("marks LAG bundles and draws the marker across the members", () => {
    const v = buildView(
      { kind: "floor", id: 20 },
      inventory([device(1, { floorId: 20 }), device(2, { floorId: 20 })]),
      emptyMap({ links: [link(1, 1, 2, { lag: "Po1" }), link(2, 1, 2, { lag: "Po1" })] }),
    );
    const bundles = lagBundles(v.edges);
    expect([...bundles.values()]).toEqual([["l:1", "l:2"]]);
    const a = route({ x: 0, y: 0, w: 136, h: 84 }, { x: 400, y: 0, w: 136, h: 84 }, -6);
    const b = route({ x: 0, y: 0, w: 136, h: 84 }, { x: 400, y: 0, w: 136, h: 84 }, 6);
    const m = lagMarker(a, b);
    expect(m.cy).toBe(42);
    expect(m.ry).toBeGreaterThan(m.rx);
  });
});

describe("guides", () => {
  it("snaps to a nearby edge and reports the line", () => {
    const g = alignmentGuides({ x: 103, y: 500, w: 50, h: 50 }, [{ x: 100, y: 0, w: 50, h: 50 }]);
    expect(g.x).toBe(100);
    expect(g.vertical).toBe(100);
    expect(g.horizontal).toBeNull();
    expect(g.y).toBe(500);
  });

  it("ignores far nodes", () => {
    const g = alignmentGuides({ x: 300, y: 300, w: 50, h: 50 }, [{ x: 0, y: 0, w: 50, h: 50 }]);
    expect(g).toEqual({ x: 300, y: 300, vertical: null, horizontal: null });
  });
});

describe("colors", () => {
  it("parses speeds", () => {
    expect(speedMbps("10G")).toBe(10_000);
    expect(speedMbps("2.5g")).toBe(2_500);
    expect(speedMbps("100M")).toBe(100);
    expect(speedMbps("1000")).toBe(1_000);
    expect(speedMbps("auto")).toBeNull();
  });

  it("colors by media, speed and VLAN", () => {
    const vlans = inventory([]).vlans;
    const l = link(1, 1, 2, { media: "sm-fiber", speed: "10G", vlans: "10,20" });
    expect(linkColor(l, "media", vlans)).toBe("var(--link-sm-fiber)");
    expect(linkColor(l, "speed", vlans)).toBe("var(--link-speed-10g)");
    expect(linkColor(l, "vlan", vlans)).toBe("#112233");
    expect(linkColor({ ...l, speed: "" }, "speed", vlans)).toBe("var(--fg-subtle)");
  });

  it("builds a legend without duplicates", () => {
    const items = legend(
      [link(1, 1, 2), link(2, 1, 3), link(3, 2, 3, { media: "wireless" })],
      "media",
      [],
    );
    expect(items.map((i) => i.label)).toEqual(["Copper", "Wireless"]);
  });

  it("lets a link override the global label toggles", () => {
    const prefs = emptyMap().prefs;
    const l = link(1, 1, 2, { labels: { ports: false, speed: true, vlans: null } });
    expect(shownLabels(l, prefs)).toEqual({ ports: false, speed: true, vlans: false });
  });
});

describe("model", () => {
  const devices = [
    device(1, { buildingId: 10, floorId: 20 }),
    device(2, { buildingId: 10, floorId: 21 }),
    device(3, { buildingId: 11 }),
    device(4),
  ];
  const inv = inventory(devices);
  const links = [link(1, 1, 2), link(2, 1, 3), link(3, 2, 3), link(4, 3, 4)];

  it("aggregates cables between buildings on the campus view", () => {
    const v = buildView({ kind: "campus", siteId: 1 }, inv, emptyMap({ links }));
    expect(v.key).toBe("campus:1");
    expect(v.nodes.map((n) => n.key).sort()).toEqual(["b:10", "b:11", "d:4"]);
    const north = v.edges.find((e) => e.key === "e:b:10|b:11");
    expect(north?.links.map((l) => l.id)).toEqual([2, 3]);
    // The link inside building 10 is not drawn on the campus.
    expect(v.edges.flatMap((e) => e.links).some((l) => l.id === 1)).toBe(false);
  });

  it("shows outside peers as external nodes in a building", () => {
    const v = buildView({ kind: "building", id: 10 }, inv, emptyMap({ links }));
    const kinds = Object.fromEntries(v.nodes.map((n) => [n.key, n.kind]));
    expect(kinds).toEqual({ "d:1": "device", "d:2": "device", "d:3": "external" });
    expect(v.nodes.find((n) => n.key === "d:2")?.band).toBe(21);
    expect(v.edges).toHaveLength(3);
  });

  it("offsets parallel links and keeps LAG members together", () => {
    const parallel = [link(1, 1, 2, { lag: "Po1" }), link(2, 1, 2), link(3, 1, 2, { lag: "Po1" })];
    const v = buildView({ kind: "floor", id: 20 }, inv, emptyMap({ links: parallel }));
    expect(v.edges.map((e) => e.links[0]!.id)).toEqual([2, 1, 3]);
    expect(v.edges.map((e) => e.offset)).toEqual([-12, 0, 12]);
  });

  it("applies stored positions and marks the rest unplaced", () => {
    const map = emptyMap({
      positions: [{ view: "campus:1", node: "b:10", x: 32, y: 48, locked: true }],
    });
    const v = buildView({ kind: "campus", siteId: 1 }, inv, map);
    const b10 = v.nodes.find((n) => n.key === "b:10")!;
    expect(b10).toMatchObject({ x: 32, y: 48, locked: true, placed: true });
    expect(v.nodes.find((n) => n.key === "b:11")?.placed).toBe(false);

    const placed = placeNew(v.nodes, 16);
    for (const n of placed.filter((x) => x.key !== "b:10")) {
      expect(n.y).toBeGreaterThan(48 + b10.h);
      expect(n.x % 16).toBe(0);
    }
  });

  it("builds keys and breadcrumbs", () => {
    expect(viewKey({ kind: "rack", floorId: 20 })).toBeNull();
    expect(breadcrumbs({ kind: "rack", floorId: 21 }, inv).map((c) => c.label)).toEqual([
      "HQ",
      "North",
      "First",
      "Racks",
    ]);
  });
});

describe("layout", () => {
  it("ranks devices by role", () => {
    expect(deviceRank(device(1, { deviceType: "firewall" }))).toBe(0);
    expect(deviceRank(device(1, { tags: ["Core"] }))).toBe(2);
    expect(deviceRank(device(1, { tags: ["access"] }))).toBe(4);
    expect(deviceRank(device(1, { deviceType: "access-point" }))).toBe(6);
  });

  it("lays out layers top-down on the grid", async () => {
    const node = (key: string, deviceId: number): NodeModel => ({
      key,
      kind: "device",
      deviceId,
      x: 0,
      y: 0,
      w: 136,
      h: 84,
      locked: false,
      placed: false,
    });
    const nodes = [node("d:1", 1), node("d:2", 2), node("d:3", 3)];
    const edges = [
      { key: "l:1", source: "d:1", target: "d:2", links: [link(1, 1, 2)], offset: 0 },
      { key: "l:2", source: "d:1", target: "d:3", links: [link(2, 1, 3)], offset: 0 },
    ];
    const layer = (n: NodeModel) => (n.key === "d:1" ? 0 : 1);
    const pos = await autoLayout(nodes, edges, layer, { x: 0, y: 0 }, 16);
    const p1 = pos.get("d:1")!;
    const p2 = pos.get("d:2")!;
    const p3 = pos.get("d:3")!;
    expect(p1.y).toBeLessThan(p2.y);
    expect(p2.y).toBe(p3.y);
    expect(p2.x).not.toBe(p3.x);
    for (const p of [p1, p2, p3]) expect(p.x % 16).toBe(0);

    // A link within one layer (a core pair) keeps both nodes on the same row.
    const pair = await autoLayout(
      [node("d:1", 1), node("d:2", 2)],
      [{ key: "l:1", source: "d:2", target: "d:1", links: [link(1, 1, 2)], offset: 0 }],
      () => 0,
      { x: 0, y: 0 },
      16,
    );
    expect(pair.get("d:1")!.y).toBe(pair.get("d:2")!.y);
  });
});

describe("floor plans", () => {
  it("fits a new plan behind the devices, keeping its aspect ratio", () => {
    const fit = fitPlan(2400, 1200, { x: 100, y: 100, w: 1000, h: 300 })!;
    // Width decides: (1000 + 2·64) / 2400.
    expect(fit.scale).toBe(0.47);
    expect(fit.x + (2400 * fit.scale) / 2).toBeCloseTo(600, 0);
    expect(fit.y + (1200 * fit.scale) / 2).toBeCloseTo(250, 0);
    expect(fitPlan(800, 600, null)).toBeNull();
    expect(fitPlan(10, 10, { x: 0, y: 0, w: 1000, h: 1000 })!.scale).toBe(4);
  });
});

describe("rack", () => {
  const rack: Rack = { id: 1, floorId: 20, roomId: null, name: "R1", heightU: 10, notes: "" };
  const racked = [device(1, { rackId: 1, rackU: 3, uHeight: 2 })];

  it("rejects overlaps and out-of-range units", () => {
    expect(fits(rack, racked, 5, 1, 99)).toBe(true);
    expect(fits(rack, racked, 4, 1, 99)).toBe(false);
    expect(fits(rack, racked, 2, 2, 99)).toBe(false);
    expect(fits(rack, racked, 10, 2, 99)).toBe(false);
    expect(fits(rack, racked, 0, 1, 99)).toBe(false);
    // A device does not collide with itself when moved by 1U.
    expect(fits(rack, racked, 4, 2, 1)).toBe(true);
  });
});

describe("exportSvg", () => {
  it("escapes text", () => {
    expect(esc(`<a & "b">`)).toBe("&lt;a &amp; &quot;b&quot;&gt;");
  });

  it("draws nodes, links, labels and the legend", () => {
    const inv = inventory([device(1, { vendor: "Cisco" }), device(2, { hostname: "<core>" })]);
    const l = link(1, 1, 2, { speed: "10G", labels: { ports: true, speed: true, vlans: null } });
    const svg = buildSvg({
      nodes: [
        { key: "d:1", kind: "device", x: 0, y: 0, w: 136, h: 84, device: inv.devices[0] },
        { key: "d:2", kind: "device", x: 400, y: 0, w: 136, h: 84, device: inv.devices[1] },
      ],
      edges: [{ key: "l:1", source: "d:1", target: "d:2", links: [l], offset: 0 }],
      zones: [
        {
          id: 1,
          view: "floor:20",
          name: "DMZ",
          color: "#ff0000",
          x: -20,
          y: -20,
          width: 200,
          height: 140,
          locked: false,
        },
      ],
      plan: null,
      inv,
      prefs: emptyMap().prefs,
      title: "HQ › North",
      date: "2026-10-18",
      legend: true,
      theme: document.documentElement,
    });
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    const texts = [...doc.querySelectorAll("text")].map((t) => t.textContent);
    expect(texts).toEqual(
      expect.arrayContaining([
        "HQ › North",
        "2026-10-18",
        "sw1",
        "<core>",
        "CISCO",
        "DMZ",
        "10G",
        "Copper",
      ]),
    );
    expect(texts.filter((t) => t === "Gi1/0/1")).toHaveLength(2);
    // The zone at -20,-20 is inside the drawing: content is translated by the padding.
    expect(doc.querySelector("svg > g")?.getAttribute("transform")).toBe("translate(52 96)");
    expect(svg).not.toContain("var(--");
  });
});
