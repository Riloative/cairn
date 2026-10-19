import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { Device } from "@/lib/ipc";
import { useInventory } from "@/stores/inventory";
import { DEFAULT_VIEW, useInventoryTable } from "@/stores/inventoryTable";
import { useNotifications } from "@/stores/notifications";
import { FakeBackend } from "@/test/fakeBackend";
import { openDevice } from "@/terminal/controller";
import { InventoryView } from "./InventoryView";
import { NEW_DEVICE } from "./model";

vi.mock("@/terminal/controller", () => ({
  openDevice: vi.fn(),
  focusActiveTerminal: vi.fn(),
}));

let backend: FakeBackend;

// jsdom has no layout; give the virtualized table a viewport so rows render.
beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
});
afterAll(() => vi.restoreAllMocks());

function seed(devices: Partial<Device>[]) {
  backend.inventory.snap.devices = devices.map((d, i) => ({ ...NEW_DEVICE, id: i + 1, ...d }));
}

function renderView() {
  return render(
    <>
      <InventoryView />
      <ConfirmDialog />
    </>,
  );
}

beforeEach(() => {
  backend = new FakeBackend("unlocked");
  useInventory.setState({ snapshot: null, error: null, section: "devices", sheet: null });
  useInventoryTable.getState().apply(DEFAULT_VIEW, null);
  useNotifications.setState({ items: [] });
  vi.mocked(openDevice).mockClear();
});

afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 0));
  backend.dispose();
});

const rows = () => screen.getAllByRole("row").slice(1);

describe("devices", () => {
  it("adds a device from the empty state and warns about a duplicate IP", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole("button", { name: "Add a device" }));

    const form = await screen.findByRole("form", { name: "New device" });
    await user.click(within(form).getByRole("button", { name: "Add device" }));
    expect(within(form).getByText("Enter a hostname.")).toBeVisible();

    await user.type(within(form).getByLabelText("Hostname"), "core-sw1");
    await user.type(within(form).getByLabelText("Management IP"), "10.0.0.300");
    await user.click(within(form).getByRole("button", { name: "Add device" }));
    expect(within(form).getByText("Enter a valid IPv4 or IPv6 address.")).toBeVisible();
    await user.clear(within(form).getByLabelText("Management IP"));
    await user.type(within(form).getByLabelText("Management IP"), "10.0.0.1");
    await user.selectOptions(within(form).getByLabelText("Vendor"), "Cisco");
    await user.type(within(form).getByLabelText("VLANs"), "10,20-22");
    await user.click(within(form).getByRole("button", { name: "Add device" }));

    // The sheet switches to the saved device's overview.
    const sheet = await screen.findByRole("dialog", { name: /core-sw1/ });
    expect(within(sheet).getAllByText("10.0.0.1").length).toBeGreaterThan(0);
    const saved = backend.inventory.snap.devices[0];
    expect(saved).toMatchObject({ hostname: "core-sw1", vendor: "Cisco", vlans: [10, 20, 21, 22] });
    expect(saved?.connections[0]?.kind).toBe("ssh");

    // A second device on the same IP saves with a warning.
    act(() => useInventory.getState().setSheet({ mode: "new" }));
    const form2 = await screen.findByRole("form", { name: "New device" });
    await user.type(within(form2).getByLabelText("Hostname"), "core-sw2");
    await user.type(within(form2).getByLabelText("Management IP"), "10.0.0.1");
    await user.click(within(form2).getByRole("button", { name: "Add device" }));
    await waitFor(() =>
      expect(useNotifications.getState().items[0]?.description).toBe(
        "10.0.0.1 is also used by core-sw1.",
      ),
    );
  });

  it("searches, filters, groups and chooses columns", async () => {
    seed([
      {
        hostname: "core-sw1",
        mgmtIp: "10.0.0.10",
        vendor: "Cisco",
        serial: "FOC123",
        tags: ["core"],
      },
      { hostname: "edge-fw", mgmtIp: "10.0.0.9", vendor: "Juniper", deviceType: "firewall" },
      { hostname: "ap-lobby", deviceType: "access-point" },
    ]);
    const user = userEvent.setup();
    renderView();
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(screen.getByText("3 devices")).toBeVisible();

    await user.type(screen.getByLabelText("Search devices"), "foc123");
    expect(rows()).toHaveLength(1);
    expect(screen.getByText("1 of 3 devices")).toBeVisible();
    await user.clear(screen.getByLabelText("Search devices"));

    await user.click(screen.getByRole("button", { name: /Filter/ }));
    await user.click(await screen.findByRole("checkbox", { name: "Firewall" }));
    expect(rows()).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /Clear filters/ }));
    await user.keyboard("{Escape}");

    await user.selectOptions(screen.getByLabelText("Grouping"), "vendor");
    const groups = screen.getAllByRole("button", { expanded: true });
    expect(groups.map((g) => g.textContent)).toEqual(["Cisco1", "Generic1", "Juniper1"]);
    await user.click(groups[0] as HTMLElement);
    expect(screen.queryByText("core-sw1")).toBeNull();

    expect(screen.queryByRole("columnheader", { name: "Serial" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(await screen.findByRole("checkbox", { name: "Serial" }));
    expect(screen.getByRole("columnheader", { name: "Serial" })).toBeVisible();
  });

  it("saves and applies a view", async () => {
    seed([
      { hostname: "a", vendor: "Cisco" },
      { hostname: "b", vendor: "Juniper" },
    ]);
    const user = userEvent.setup();
    renderView();
    await waitFor(() => expect(rows()).toHaveLength(2));
    await user.type(screen.getByLabelText("Search devices"), "a");
    await user.click(screen.getByRole("button", { name: "Views" }));
    await user.click(await screen.findByRole("menuitem", { name: "Save current view…" }));
    await user.type(await screen.findByLabelText("Name"), "Only a");
    await user.click(screen.getByRole("button", { name: "Save view" }));
    expect(await screen.findByRole("button", { name: "Only a" })).toBeVisible();
    expect(backend.inventory.snap.views[0]?.state).toMatchObject({ search: "a" });

    await user.click(screen.getByRole("button", { name: "Only a" }));
    await user.click(await screen.findByRole("menuitem", { name: "All devices" }));
    expect(rows()).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Views" }));
    await user.click(await screen.findByRole("menuitem", { name: /Only a/ }));
    expect(rows()).toHaveLength(1);
  });

  it("connects on double-click and opens details on click", async () => {
    seed([{ hostname: "core-sw1", mgmtIp: "10.0.0.1" }]);
    const user = userEvent.setup();
    renderView();
    await waitFor(() => expect(rows()).toHaveLength(1));
    const row = rows()[0] as HTMLElement;
    await user.dblClick(row);
    expect(openDevice).toHaveBeenCalledWith(expect.objectContaining({ hostname: "core-sw1" }), 0);
    // A double-click connects without opening the details sheet.
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(row);
    const sheet = await screen.findByRole("dialog", { name: /core-sw1/ });
    await user.click(within(sheet).getByRole("button", { name: "SSH" }));
    expect(openDevice).toHaveBeenCalledTimes(2);
  });

  it("bulk-creates interfaces with a preview", async () => {
    seed([{ hostname: "sw1" }]);
    const user = userEvent.setup();
    useInventory.setState({ sheet: { mode: "view", deviceId: 1, tab: "interfaces" } });
    renderView();
    await user.click(await screen.findByRole("button", { name: "Add interfaces" }));
    await user.type(await screen.findByLabelText("Names"), "Gi1/0/1-4");
    expect(
      await screen.findByText(/4 interfaces: Gi1\/0\/1, Gi1\/0\/2, Gi1\/0\/3, Gi1\/0\/4/),
    ).toBeVisible();
    await user.click(screen.getByRole("radio", { name: "Trunk" }));
    await user.type(screen.getByLabelText(/Allowed VLANs/), "10,20");
    await user.click(screen.getByRole("button", { name: "Add 4" }));
    expect(await screen.findByRole("button", { name: "Gi1/0/4" })).toBeVisible();
    expect(backend.inventory.interfaces[0]).toMatchObject({ mode: "trunk", allowedVlans: "10,20" });
    expect(screen.getByRole("tab", { name: "Interfaces (4)" })).toBeVisible();
  });

  it("deletes after confirmation", async () => {
    seed([{ hostname: "old-sw" }]);
    const user = userEvent.setup();
    useInventory.setState({ sheet: { mode: "view", deviceId: 1 } });
    renderView();
    await user.click(await screen.findByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await user.click(await screen.findByRole("button", { name: "Delete device" }));
    await waitFor(() => expect(backend.inventory.snap.devices).toHaveLength(0));
    expect(await screen.findByText("No devices yet")).toBeVisible();
  });
});

describe("other sections", () => {
  it("manages locations and places a device in a rack", async () => {
    const user = userEvent.setup();
    useInventory.setState({ section: "locations" });
    renderView();
    await user.click(await screen.findByRole("button", { name: "Add a building" }));
    await user.type(await screen.findByLabelText("Name"), "HQ");
    await user.click(screen.getByRole("button", { name: "Add building" }));
    await user.click(await screen.findByRole("button", { name: "Actions for HQ" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add floor" }));
    await user.type(await screen.findByLabelText("Name"), "Ground");
    await user.click(screen.getByRole("button", { name: "Add floor" }));
    await user.click(await screen.findByRole("button", { name: "Actions for Ground" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add rack" }));
    await user.type(await screen.findByLabelText("Name"), "R1");
    await user.click(screen.getByRole("button", { name: "Add rack" }));
    expect(await screen.findByText("0/42 U used")).toBeVisible();

    act(() => useInventory.setState({ section: "devices", sheet: { mode: "new" } }));
    const form = await screen.findByRole("form", { name: "New device" });
    await user.type(within(form).getByLabelText("Hostname"), "sw1");
    await user.selectOptions(within(form).getByLabelText("Building"), "HQ");
    await user.selectOptions(within(form).getByLabelText("Floor"), "Ground");
    await user.selectOptions(within(form).getByLabelText("Rack"), "R1 (42 U)");
    await user.type(within(form).getByLabelText("Position (lowest U)"), "43");
    await user.click(within(form).getByRole("button", { name: "Add device" }));
    expect(within(form).getByText("Must fit inside R1 (U1–U42).")).toBeVisible();
    await user.clear(within(form).getByLabelText("Position (lowest U)"));
    await user.type(within(form).getByLabelText("Position (lowest U)"), "40");
    await user.click(within(form).getByRole("button", { name: "Add device" }));
    await waitFor(() => expect(backend.inventory.snap.devices[0]?.rackU).toBe(40));
  });

  it("keeps secrets write-only and audits reveal and copy", async () => {
    const user = userEvent.setup();
    useInventory.setState({ section: "credentials" });
    renderView();
    await user.click(await screen.findByRole("button", { name: "Add a profile" }));
    await user.type(await screen.findByLabelText("Name"), "Lab");
    await user.type(screen.getByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "s3cret");
    await user.type(screen.getByLabelText("Enable secret"), "en4ble");
    await user.click(screen.getByRole("switch", { name: "Enter enable mode on connect" }));
    await user.click(screen.getByRole("button", { name: "Add profile" }));

    expect(await screen.findByText("password · enable (auto)")).toBeVisible();
    expect(backend.inventory.secrets.get(backend.inventory.snap.credentials[0]?.id ?? 0)).toEqual({
      password: "s3cret",
      enableSecret: "en4ble",
    });
    // The snapshot the UI holds never contains secret values.
    expect(JSON.stringify(useInventory.getState().snapshot)).not.toContain("s3cret");

    await user.click(screen.getByRole("button", { name: "Lab" }));
    const stored = await screen.findByLabelText("Password (stored)");
    expect(stored).toHaveValue("••••••••••");
    await user.click(screen.getByRole("button", { name: "Reveal Password" }));
    await waitFor(() => expect(stored).toHaveValue("s3cret"));
    await user.click(screen.getByRole("button", { name: "Copy Enable secret" }));
    const kinds = backend.audit.map((e) => e.kind);
    expect(kinds).toContain("credential_revealed");
    expect(kinds).toContain("credential_copied");

    // Saving without touching secrets keeps them (nothing is re-sent).
    await user.click(screen.getByRole("button", { name: "Save" }));
    const lastSave = backend.calls.filter((c) => c.cmd === "credential_save").at(-1);
    expect(lastSave?.args.credential).toMatchObject({
      password: { action: "keep" },
      enableSecret: { action: "keep" },
    });
  });

  it("adds a VLAN and a custom field that shows up on devices", async () => {
    const user = userEvent.setup();
    useInventory.setState({ section: "vlans" });
    renderView();
    await user.click(await screen.findByRole("button", { name: "Add a VLAN" }));
    await user.type(await screen.findByLabelText("VLAN ID"), "20");
    await user.type(screen.getByLabelText("Subnet"), "10.1.20.0/33");
    await user.click(screen.getByRole("button", { name: "Add VLAN" }));
    expect(screen.getByText("Use a prefix like 10.1.20.0/24.")).toBeVisible();
    await user.clear(screen.getByLabelText("Subnet"));
    await user.type(screen.getByLabelText("Subnet"), "10.1.20.0/24");
    await user.click(screen.getByRole("radio", { name: "#10b981" }));
    await user.click(screen.getByRole("button", { name: "Add VLAN" }));
    expect(await screen.findByText("10.1.20.0/24")).toBeVisible();
    expect(backend.inventory.snap.vlans[0]).toMatchObject({ vid: 20, color: "#10b981" });

    act(() => useInventory.setState({ section: "fields" }));
    await user.click(await screen.findByRole("button", { name: "Add a field" }));
    await user.type(await screen.findByLabelText("Name"), "Owner");
    await user.selectOptions(screen.getByLabelText("Type"), "select");
    await user.type(screen.getByLabelText(/Options/), "NetOps{Enter}SecOps");
    await user.click(screen.getByRole("button", { name: "Add field" }));
    expect(await screen.findByText(/Select: NetOps, SecOps/)).toBeVisible();

    act(() => useInventory.setState({ section: "devices", sheet: { mode: "new" } }));
    const form = await screen.findByRole("form", { name: "New device" });
    await user.type(within(form).getByLabelText("Hostname"), "sw9");
    await user.selectOptions(within(form).getByLabelText("Owner"), "SecOps");
    await user.click(within(form).getByRole("button", { name: "Add device" }));
    await waitFor(() =>
      expect(backend.inventory.snap.devices[0]?.custom).toEqual({ owner: "SecOps" }),
    );
  });

  it("shows a rack's devices when the rack is opened", async () => {
    const user = userEvent.setup();
    const inv = backend.inventory.snap;
    inv.buildings = [{ id: 10, siteId: 1, name: "North", code: "N", address: "", notes: "" }];
    inv.floors = [{ id: 20, buildingId: 10, name: "Ground", level: 0, notes: "" }];
    inv.racks = [{ id: 30, floorId: 20, roomId: null, name: "R1", heightU: 12, notes: "" }];
    seed([
      { hostname: "core-sw1", buildingId: 10, floorId: 20, rackId: 30, rackU: 5, uHeight: 2 },
      { hostname: "loose-ap", buildingId: 10, floorId: 20 },
    ]);
    useInventory.setState({ section: "locations" });
    renderView();
    // Collapsed at first; clicking the rack's name opens its elevation.
    expect(screen.queryByRole("figure", { name: "Rack R1 elevation" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "R1" }));
    const rack = await screen.findByRole("figure", { name: "Rack R1 elevation" });
    expect(within(rack).getByRole("button", { name: "core-sw1, U5–U6" })).toBeVisible();
    expect(within(rack).queryByText("loose-ap")).toBeNull();
    await user.click(within(rack).getByRole("button", { name: "core-sw1, U5–U6" }));
    expect(useInventory.getState().sheet).toEqual({ mode: "view", deviceId: 1 });
  });
});
