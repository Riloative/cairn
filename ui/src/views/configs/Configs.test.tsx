import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { Device } from "@/lib/ipc";
import { useNotifications } from "@/stores/notifications";
import { useSessions } from "@/stores/sessions";
import { FakeBackend } from "@/test/fakeBackend";
import { openDevice } from "@/terminal/controller";
import { NEW_DEVICE } from "@/views/inventory/model";
import { ConfigHistory } from "./ConfigHistory";
import { foldRows } from "./fold";
import { useGrab } from "./grab";

vi.mock("@/terminal/controller", () => ({
  backendSessionId: (tabId: string) => `s-${tabId}`,
  openDevice: vi.fn(),
}));

let backend: FakeBackend;
const sw1: Device = {
  ...NEW_DEVICE,
  id: 7,
  hostname: "sw1",
  vendor: "Cisco",
  connections: [
    { kind: "ssh", port: 22, username: "", legacy: [], jumps: "", agentForwarding: false },
  ],
};

beforeEach(() => {
  backend = new FakeBackend("unlocked");
  useGrab.setState({ running: [], version: 0 });
  useNotifications.setState({ items: [] });
  vi.mocked(openDevice).mockReset();
  useSessions.setState({
    tabs: [
      {
        id: "t1",
        title: "sw1",
        protocol: "ssh",
        state: "connected",
        device: { id: 7, vendor: "Cisco" },
      },
    ],
    activeId: "t1",
  });
});

afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 0));
  backend.dispose();
});

function renderHistory() {
  return render(
    <>
      <ConfigHistory device={sw1} />
      <ConfirmDialog />
    </>,
  );
}

describe("config grab and history", () => {
  it("grabs over the open SSH tab, then compares the latest two snapshots", async () => {
    const user = userEvent.setup();
    renderHistory();
    expect(await screen.findByText("No snapshots yet.")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Grab config" }));
    await waitFor(() => expect(backend.snapshots).toHaveLength(1));
    expect(backend.audit[0]?.payload).toMatchObject({ deviceId: 7, sessionId: "s-t1" });
    expect(openDevice).not.toHaveBeenCalled();
    expect(useNotifications.getState().items[0]?.title).toBe("Saved the configuration of sw1");

    backend.nextConfig = "hostname sw1-new\n!\nend\nntp server 10.0.0.1\n";
    await user.click(screen.getByRole("button", { name: "Grab config" }));
    const list = await screen.findByRole("list", { name: "Snapshots" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2));
    expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("changed");

    await user.click(screen.getByRole("button", { name: "Compare latest" }));
    const viewer = await screen.findByRole("dialog", { name: "sw1: changes" });
    expect(await within(viewer).findByText("+2")).toBeVisible();
    expect(within(viewer).getByText("−1")).toBeVisible();
    expect(within(viewer).getAllByText("hostname").length).toBeGreaterThan(0);

    backend.dialogResult = "/home/me/sw1.diff";
    await user.click(within(viewer).getByRole("button", { name: "Export diff…" }));
    await waitFor(() =>
      expect(backend.audit[0]).toMatchObject({
        kind: "data_exported",
        payload: { path: "/home/me/sw1.diff", against: 1 },
      }),
    );
  });

  it("opens an SSH session when none is connected, and deletes snapshots", async () => {
    useSessions.setState({ tabs: [], activeId: null });
    vi.mocked(openDevice).mockImplementation(async () => {
      useSessions.setState({
        tabs: [
          {
            id: "t9",
            title: "sw1",
            protocol: "ssh",
            state: "connecting",
            device: { id: 7, vendor: "Cisco" },
          },
        ],
      });
      setTimeout(() =>
        useSessions.setState({
          tabs: [
            {
              id: "t9",
              title: "sw1",
              protocol: "ssh",
              state: "connected",
              device: { id: 7, vendor: "Cisco" },
            },
          ],
        }),
      );
      return "t9";
    });
    const user = userEvent.setup();
    renderHistory();
    await user.click(await screen.findByRole("button", { name: "Grab config" }));
    await waitFor(() => expect(backend.snapshots).toHaveLength(1));
    expect(openDevice).toHaveBeenCalledWith(sw1, 0);
    expect(backend.audit[0]?.payload).toMatchObject({ sessionId: "s-t9" });

    await user.click(await screen.findByRole("button", { name: /Delete snapshot/ }));
    await user.click(await screen.findByRole("button", { name: "Delete snapshot" }));
    expect(await screen.findByText("No snapshots yet.")).toBeVisible();
  });

  it("folds long unchanged runs but keeps context around changes", () => {
    const same = (n: number) => ({
      kind: "same" as const,
      left: { n, text: "x" },
      right: { n, text: "x" },
    });
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => same(i + 1)),
      { kind: "changed" as const, left: { n: 11, text: "a" }, right: { n: 11, text: "b" } },
      ...Array.from({ length: 10 }, (_, i) => same(i + 12)),
    ];
    const blocks = foldRows(rows);
    expect(blocks.map((b) => [b.kind, b.rows.length])).toEqual([
      ["fold", 7],
      ["rows", 7],
      ["fold", 7],
    ]);
    // Short runs near a change are never folded.
    expect(foldRows(rows.slice(5, 16)).every((b) => b.kind === "rows")).toBe(true);
  });
});
