import { describe, expect, it } from "vitest";
import type { Device, InventorySnapshot } from "@/lib/ipc";
import { NEW_DEVICE } from "./model";
import {
  compareIp,
  EMPTY_FACETS,
  type Facets,
  filterDevices,
  groupKey,
  groupRows,
  locationLabel,
  searchText,
} from "./query";
import { formatVlanList, hostnameError, isIp, parseVlanList } from "./validate";

const dev = (id: number, patch: Partial<Device>): Device => ({ ...NEW_DEVICE, id, ...patch });

const snap: InventorySnapshot = {
  sites: [{ id: 1, name: "Campus", notes: "" }],
  buildings: [{ id: 1, siteId: 1, name: "HQ", code: "", address: "", notes: "" }],
  floors: [{ id: 2, buildingId: 1, name: "2nd", level: 2, notes: "" }],
  rooms: [],
  racks: [{ id: 3, floorId: 2, roomId: null, name: "R1", heightU: 42, notes: "" }],
  vendors: ["Cisco", "Juniper", "Generic"],
  credentials: [],
  vlans: [],
  fields: [{ id: 1, key: "owner", label: "Owner", kind: "text", options: [], position: 0 }],
  devices: [
    dev(1, {
      hostname: "core-sw1",
      mgmtIp: "10.0.0.10",
      vendor: "Cisco",
      buildingId: 1,
      floorId: 2,
      rackId: 3,
      rackU: 12,
      tags: ["core"],
      custom: { owner: "NetOps" },
    }),
    dev(2, { hostname: "edge-fw", mgmtIp: "10.0.0.9", vendor: "Juniper", deviceType: "firewall" }),
    dev(3, { hostname: "ap-lobby", deviceType: "access-point", tags: ["wifi"] }),
  ],
  views: [],
};

describe("inventory queries", () => {
  it("labels locations and indexes every searchable field", () => {
    const d = snap.devices[0] as Device;
    expect(locationLabel(d, snap)).toBe("HQ · 2nd · R1 U12");
    expect(searchText(d, snap)).toContain("netops");
    expect(searchText(d, snap)).toContain("10.0.0.10");
  });

  it("filters by words and facets", () => {
    const names = (s: string, f: Facets = EMPTY_FACETS) =>
      filterDevices(snap, s, f).map((d) => d.hostname);
    expect(names("")).toHaveLength(3);
    expect(names("netops r1")).toEqual(["core-sw1"]);
    expect(names("10.0.0")).toEqual(["core-sw1", "edge-fw"]);
    expect(names("", { type: ["firewall"], vendor: [], building: [], tag: [] })).toEqual([
      "edge-fw",
    ]);
    expect(names("", { type: [], vendor: [], building: ["none"], tag: [] })).toEqual([
      "edge-fw",
      "ap-lobby",
    ]);
    expect(names("", { type: [], vendor: [], building: [], tag: ["wifi"] })).toEqual(["ap-lobby"]);
  });

  it("groups sorted rows with 'No …' groups last and honors collapse", () => {
    const keyOf = (d: Device) => groupKey(d, "building", snap);
    const items = groupRows(snap.devices, keyOf, "building", new Set());
    expect(
      items.map((i) => (i.kind === "group" ? `[${i.key} ${i.count}]` : i.row.hostname)),
    ).toEqual(["[HQ 1]", "core-sw1", "[No building 2]", "edge-fw", "ap-lobby"]);
    const collapsed = groupRows(snap.devices, keyOf, "building", new Set(["No building"]));
    expect(collapsed).toHaveLength(3);
    expect(groupRows(snap.devices, keyOf, "none", new Set())).toHaveLength(3);
  });

  it("sorts IPv4 numerically", () => {
    expect(["10.0.0.10", "", "10.0.0.9", "9.1.1.1"].sort(compareIp)).toEqual([
      "9.1.1.1",
      "10.0.0.9",
      "10.0.0.10",
      "",
    ]);
  });
});

describe("client validation", () => {
  it("checks addresses, hostnames and VLAN lists", () => {
    expect(isIp("10.0.0.1")).toBe(true);
    expect(isIp("10.0.0.256")).toBe(false);
    expect(isIp("010.0.0.1")).toBe(false);
    expect(isIp("2001:db8::1")).toBe(true);
    expect(isIp("[fe80::1]")).toBe(true);
    expect(isIp("core-sw1")).toBe(false);
    expect(hostnameError("core sw")).toBeTruthy();
    expect(hostnameError("core-sw1.lab")).toBeUndefined();
    expect(parseVlanList("99, 10-12,1")).toEqual([1, 10, 11, 12, 99]);
    expect(parseVlanList("0")).toBeNull();
    expect(parseVlanList("20-10")).toBeNull();
    expect(formatVlanList([1, 10, 11, 12, 99])).toBe("1,10-12,99");
  });
});
