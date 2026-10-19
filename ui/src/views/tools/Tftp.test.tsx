import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useNotifications } from "@/stores/notifications";
import { useTftp } from "@/stores/tftp";
import { FakeBackend } from "@/test/fakeBackend";
import { TftpSection } from "./TftpSection";

let backend: FakeBackend;

beforeEach(() => {
  backend = new FakeBackend("unlocked");
  useTftp.setState({ status: null, busy: false });
  useNotifications.setState({ items: [] });
});

afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 0));
  backend.dispose();
});

describe("TFTP server", () => {
  it("starts with the chosen folder and shows the device command", async () => {
    const user = userEvent.setup();
    render(<TftpSection />);
    const form = await screen.findByRole("form", { name: "TFTP server" });
    const start = within(form).getByRole("button", { name: "Start server" });
    expect(start).toBeDisabled();
    expect(within(form).getByText("Choose a folder to start.")).toBeVisible();

    backend.dialogResult = "/srv/tftp";
    await user.click(within(form).getByRole("button", { name: /Choose/ }));
    await waitFor(() => expect(start).toBeEnabled());
    await user.selectOptions(within(form).getByLabelText("Listen on"), "192.168.1.10");
    await user.click(within(form).getByRole("switch", { name: "Allow uploads" }));
    await user.click(start);

    expect(await screen.findByText("Serving on 192.168.1.10:6969")).toBeVisible();
    expect(screen.getByText("copy tftp://192.168.1.10:6969/<file> flash:")).toBeVisible();
    expect(backend.tftp.prefs).toMatchObject({ root: "/srv/tftp", allowWrite: true });
    expect(backend.audit[0]?.kind).toBe("tftp_server");

    await user.click(screen.getByRole("button", { name: "Stop server" }));
    expect(await screen.findByText("TFTP server is off")).toBeVisible();
  });

  it("explains privileged ports and shows live transfers", async () => {
    backend.tftp.prefs.root = "/srv/tftp";
    const user = userEvent.setup();
    render(<TftpSection />);
    const form = await screen.findByRole("form", { name: "TFTP server" });
    const port = within(form).getByLabelText("Port");
    await user.clear(port);
    await user.type(port, "69");
    expect(within(form).getByText(/cap_net_bind_service/)).toBeVisible();
    await user.click(within(form).getByRole("button", { name: "Start server" }));
    await waitFor(() =>
      expect(useNotifications.getState().items[0]?.title).toBe("Could not start the TFTP server"),
    );

    act(() =>
      useTftp.getState().applyEntry({
        id: 1,
        at: new Date().toISOString(),
        peer: "10.0.0.2:51000",
        file: "c9300.bin",
        direction: "read",
        size: 2048,
        bytes: 1024,
        state: "running",
        error: null,
      }),
    );
    const row = screen.getByText("c9300.bin").closest("tr")!;
    expect(row).toHaveTextContent("50%");
    act(() =>
      useTftp.getState().applyEntry({
        id: 1,
        at: new Date().toISOString(),
        peer: "10.0.0.2:51000",
        file: "c9300.bin",
        direction: "read",
        size: 2048,
        bytes: 2048,
        state: "done",
        error: null,
      }),
    );
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("c9300.bin").closest("tr")).toHaveTextContent("done");
  });
});
