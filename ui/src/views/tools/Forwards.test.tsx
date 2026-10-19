import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useForwards } from "@/stores/forwards";
import { useNotifications } from "@/stores/notifications";
import { useSessions } from "@/stores/sessions";
import { FakeBackend } from "@/test/fakeBackend";
import { ForwardsSection } from "./ForwardsSection";

vi.mock("@/terminal/controller", () => ({
  backendSessionId: (tabId: string) => `s-${tabId}`,
}));

let backend: FakeBackend;

beforeEach(() => {
  backend = new FakeBackend("unlocked");
  useForwards.setState({ active: [], presets: null, preselectTab: null });
  useNotifications.setState({ items: [] });
  useSessions.setState({
    tabs: [
      {
        id: "t1",
        title: "core-1",
        protocol: "ssh",
        state: "connected",
        device: { id: 3, vendor: "Cisco" },
      },
      { id: "t2", title: "fw", protocol: "ssh", state: "connecting" },
      { id: "t3", title: "console", protocol: "serial", state: "connected" },
    ],
    activeId: "t1",
  });
});

afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 0));
  backend.dispose();
});

describe("port forwards", () => {
  it("starts a local forward over a connected SSH session and saves a preset", async () => {
    const user = userEvent.setup();
    render(<ForwardsSection />);
    const form = await screen.findByRole("form", { name: "New port forward" });
    const session = within(form).getByLabelText("Over session");
    expect(
      within(session)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["core-1"]);

    await user.click(within(form).getByRole("button", { name: "Start forward" }));
    expect(within(form).getByText("Enter the destination host.")).toBeVisible();

    await user.type(within(form).getByLabelText("Destination host"), "10.0.0.5");
    await user.click(within(form).getByRole("switch", { name: "Save as preset" }));
    await user.click(within(form).getByRole("button", { name: "Start forward" }));

    expect(await screen.findByText("L 127.0.0.1:40000 → 10.0.0.5:443")).toBeVisible();
    expect(backend.forwards[0]?.sessionId).toBe("s-t1");
    await waitFor(() => expect(backend.forwardPresets).toHaveLength(1));
    expect(backend.forwardPresets[0]).toMatchObject({
      deviceId: 3,
      autoStart: true,
      destHost: "10.0.0.5",
    });
    expect(await screen.findByRole("switch", { name: /Auto-start L 127.0.0.1:0/ })).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Stop L 127.0.0.1:40000 → 10.0.0.5:443" }));
    expect(await screen.findByText("No port forwards are running.")).toBeVisible();
    expect(backend.audit.map((e) => e.payload.action)).toEqual(["stopped", "started"]);
  });

  it("offers SOCKS without a destination and reports bind errors", async () => {
    const user = userEvent.setup();
    render(<ForwardsSection />);
    const form = await screen.findByRole("form", { name: "New port forward" });
    await user.click(within(form).getByRole("radio", { name: "SOCKS (-D)" }));
    expect(within(form).queryByLabelText("Destination host")).not.toBeInTheDocument();
    const port = within(form).getByLabelText("Port");
    await user.clear(port);
    await user.type(port, "22");
    await user.click(within(form).getByRole("button", { name: "Start forward" }));
    await waitFor(() =>
      expect(useNotifications.getState().items[0]?.title).toBe("Could not start the port forward"),
    );
  });
});
