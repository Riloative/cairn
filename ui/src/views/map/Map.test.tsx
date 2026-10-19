import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TooltipProvider } from "@/components/ui/Tooltip";
import type { Device, Interface } from "@/lib/ipc";
import { useGlobalShortcuts } from "@/app/useGlobalShortcuts";
import { useInventory } from "@/stores/inventory";
import { useMap } from "@/stores/map";
import { useNotifications } from "@/stores/notifications";
import { useUi } from "@/stores/ui";
import { FakeBackend } from "@/test/fakeBackend";
import { IFACE_TEMPLATE, NEW_DEVICE } from "@/views/inventory/model";
import { MapView } from "./MapView";
import { useMapUi } from "./mapUi";

vi.mock("@/terminal/controller", () => ({
  openDevice: vi.fn(),
  openLocalShell: vi.fn(),
  focusActiveTerminal: vi.fn(),
}));

// React Flow measures nodes; jsdom has no layout (see React Flow's testing guide).
class MeasuringResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(target: Element) {
    this.cb(
      [{ target, contentRect: { width: 1200, height: 800 } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

class DOMMatrixStub {
  m22 = 1;
}

const original = { ro: globalThis.ResizeObserver };
beforeAll(() => {
  globalThis.ResizeObserver = MeasuringResizeObserver as unknown as typeof ResizeObserver;
  (globalThis as Record<string, unknown>).DOMMatrixReadOnly = DOMMatrixStub;
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(136);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(84);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
});
afterAll(() => {
  globalThis.ResizeObserver = original.ro;
  vi.restoreAllMocks();
});

let backend: FakeBackend;

function seed() {
  const inv = backend.inventory.snap;
  inv.buildings = [{ id: 10, siteId: 1, name: "North", code: "N", address: "", notes: "" }];
  inv.floors = [{ id: 20, buildingId: 10, name: "Ground", level: 0, notes: "" }];
  inv.racks = [{ id: 30, floorId: 20, roomId: null, name: "R1", heightU: 12, notes: "" }];
  const device = (id: number, over: Partial<Device>): Device => ({
    ...NEW_DEVICE,
    id,
    hostname: `sw${id}`,
    mgmtIp: `10.0.0.${id}`,
    buildingId: 10,
    floorId: 20,
    ...over,
  });
  inv.devices = [
    device(1, { tags: ["core"], rackId: 30, rackU: 5 }),
    device(2, { tags: ["access"] }),
    device(3, { buildingId: null, floorId: null, hostname: "wan-edge", deviceType: "router" }),
  ];
  const iface = (id: number, deviceId: number, name: string): Interface => ({
    ...IFACE_TEMPLATE,
    id,
    deviceId,
    name,
    speed: "1G",
  });
  backend.inventory.interfaces = [
    iface(101, 1, "Gi1/0/1"),
    iface(102, 1, "Gi1/0/2"),
    iface(201, 2, "Gi0/1"),
    iface(301, 3, "ge-0/0/0"),
  ];
}

function Shortcuts() {
  useGlobalShortcuts();
  return null;
}

function renderView() {
  return render(
    <TooltipProvider>
      <Shortcuts />
      <MapView />
      <ConfirmDialog />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  backend = new FakeBackend("unlocked");
  useInventory.setState({ snapshot: null, error: null });
  useMap.setState({
    data: null,
    error: null,
    view: null,
    past: [],
    future: [],
    layoutLocked: false,
  });
  useMapUi.getState().reset();
  useNotifications.setState({ items: [] });
  useUi.setState({ view: "map" });
});

afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 0));
  backend.dispose();
});

describe("map", () => {
  it("shows an empty state that leads to the inventory", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole("button", { name: "Open inventory" }));
    expect(useUi.getState().view).toBe("inventory");
  });

  it("lays out the campus on first open and stores the positions", async () => {
    seed();
    renderView();
    expect(await screen.findByText("North")).toBeInTheDocument();
    expect(screen.getByText("wan-edge")).toBeInTheDocument();
    await waitFor(() => expect(backend.map.data.positions).toHaveLength(2));
    expect(backend.map.data.positions.map((p) => p.view)).toEqual(["campus:1", "campus:1"]);
    expect(screen.getByRole("navigation", { name: "Map location" })).toHaveTextContent("Campus");
  });

  it("drills into a building and shows floor bands and external peers", async () => {
    seed();
    backend.map.saveLink({
      ...LINK,
      aInterfaceId: 201,
      bInterfaceId: 301,
    });
    renderView();
    await screen.findByText("North");
    act(() => useMap.getState().setView({ kind: "building", id: 10 }));
    expect(await screen.findByText("sw1")).toBeInTheDocument();
    expect(screen.getByText("sw2")).toBeInTheDocument();
    // wan-edge is outside the building but linked to sw2: shown as a dimmed peer.
    expect(screen.getByText("wan-edge")).toBeInTheDocument();
    // The overview draws the devices and the link between them, plus the visible area.
    const overview = screen.getByRole("img", { name: "Map overview" });
    await waitFor(() => expect(overview.querySelectorAll("line")).toHaveLength(1));
    expect(overview.querySelectorAll("rect").length).toBeGreaterThanOrEqual(4);
    const crumbs = screen.getByRole("navigation", { name: "Map location" });
    expect(within(crumbs).getByRole("button", { name: "North" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await userEvent.setup().click(within(crumbs).getByRole("button", { name: "Campus" }));
    expect(useMap.getState().view).toEqual({ kind: "campus", siteId: 1 });
  });

  it("creates a link interface to interface, with a new interface on one side", async () => {
    seed();
    const user = userEvent.setup();
    renderView();
    await screen.findByText("North");
    act(() => useMapUi.getState().setLinkDialog({ mode: "new", aDeviceId: 1, bDeviceId: 2 }));
    const dialog = await screen.findByRole("dialog", { name: "New link" });
    const sideA = within(dialog).getByRole("radiogroup", { name: "sw1 interface" });
    await user.click(await within(sideA).findByRole("radio", { name: /Gi1\/0\/2/ }));

    await user.click(within(dialog).getByRole("button", { name: "Add link" }));
    expect(within(dialog).getByText("Choose an interface on each side.")).toBeVisible();

    await user.type(within(dialog).getByLabelText("Filter sw2 interfaces"), "Te1/1/1");
    await user.click(within(dialog).getByRole("button", { name: /Create Te1\/1\/1/ }));
    const sideB = within(dialog).getByRole("radiogroup", { name: "sw2 interface" });
    expect(await within(sideB).findByRole("radio", { name: /Te1\/1\/1/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.selectOptions(within(dialog).getByLabelText("Media"), "sm-fiber");
    expect(within(dialog).getByRole("textbox", { name: /^Speed/ })).toHaveValue("1G");
    await user.click(within(dialog).getByRole("button", { name: "Add link" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const [l] = backend.map.data.links;
    expect(l).toMatchObject({ aName: "Gi1/0/2", bName: "Te1/1/1", media: "sm-fiber" });
    expect(backend.audit[0]?.payload).toMatchObject({
      entity: "link",
      name: "sw1 Gi1/0/2 ↔ sw2 Te1/1/1",
    });
    // Each interface takes part in one link: Gi1/0/2 is now marked as connected.
    act(() => useMapUi.getState().setLinkDialog({ mode: "new", aDeviceId: 1, bDeviceId: 3 }));
    const again = await screen.findByRole("dialog", { name: "New link" });
    expect(await within(again).findByRole("radio", { name: /Gi1\/0\/2/ })).toBeDisabled();
  });

  it("undoes and redoes layout changes", async () => {
    seed();
    renderView();
    await waitFor(() => expect(backend.map.data.positions).toHaveLength(2));
    const before = backend.map.data.positions.find((p) => p.node === "b:10")!;
    const moved = { ...before, x: before.x + 160 };
    await act(() => useMap.getState().savePositions([moved], [before]));
    expect(backend.map.data.positions.find((p) => p.node === "b:10")?.x).toBe(moved.x);

    await act(() => useMap.getState().undo());
    expect(backend.map.data.positions.find((p) => p.node === "b:10")?.x).toBe(before.x);
    await act(() => useMap.getState().redo());
    expect(backend.map.data.positions.find((p) => p.node === "b:10")?.x).toBe(moved.x);
  });

  it("leaves Ctrl+Z to text fields and undoes the layout elsewhere", async () => {
    seed();
    const user = userEvent.setup();
    renderView();
    await waitFor(() => expect(backend.map.data.positions).toHaveLength(2));
    const before = backend.map.data.positions.find((p) => p.node === "b:10")!;
    await act(() => useMap.getState().savePositions([{ ...before, x: 999 }], [before]));

    await user.click(screen.getByLabelText("Find on map"));
    await user.keyboard("{Control>}z{/Control}");
    expect(useMap.getState().past).toHaveLength(1);

    (document.activeElement as HTMLElement).blur();
    await user.keyboard("{Control>}z{/Control}");
    await waitFor(() => expect(useMap.getState().past).toHaveLength(0));
    expect(backend.map.data.positions.find((p) => p.node === "b:10")?.x).toBe(before.x);
  });

  it("exports a PNG through the save dialog and the Rust renderer", async () => {
    seed();
    const user = userEvent.setup();
    renderView();
    await screen.findByText("North");
    act(() => useMapUi.getState().setExportOpen(true));
    const dialog = await screen.findByRole("dialog", { name: "Export map" });
    backend.dialogResult = "/home/me/campus.png";
    await user.click(within(dialog).getByRole("button", { name: "Export…" }));

    await waitFor(() => expect(backend.map.exports).toHaveLength(1));
    const [e] = backend.map.exports;
    expect(e).toMatchObject({ format: "png", scale: 2, path: "/home/me/campus.png" });
    expect(e?.svg).toContain(">North<");
    expect(e?.svg).toContain(">wan-edge<");
    expect(backend.audit[0]?.kind).toBe("data_exported");
    await waitFor(() =>
      expect(useNotifications.getState().items[0]).toMatchObject({
        title: "Map exported",
        description: "/home/me/campus.png",
      }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("re-racks a device from the keyboard", async () => {
    seed();
    const user = userEvent.setup();
    renderView();
    await screen.findByText("North");
    act(() => useMap.getState().setView({ kind: "rack", floorId: 20 }));
    const rack = await screen.findByRole("region", { name: "Rack R1" });
    const sw1 = within(rack).getByRole("button", { name: "sw1, U5" });
    sw1.focus();
    await user.keyboard("{ArrowUp}");
    await waitFor(() =>
      expect(backend.inventory.snap.devices.find((d) => d.id === 1)?.rackU).toBe(6),
    );
    expect(screen.getByRole("complementary", { name: "Not racked" })).toHaveTextContent("sw2");
  });
});

const LINK = {
  id: 0,
  aInterfaceId: 0,
  bInterfaceId: 0,
  aDeviceId: 0,
  bDeviceId: 0,
  aName: "",
  bName: "",
  media: "copper" as const,
  speed: "",
  vlans: "",
  lag: "",
  description: "",
  labels: { ports: null, speed: null, vlans: null },
};
