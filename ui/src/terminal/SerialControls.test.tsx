import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { useNotifications } from "@/stores/notifications";
import { useSerial } from "@/stores/serial";
import { useSessions, type SessionTab } from "@/stores/sessions";
import { FakeBackend } from "@/test/fakeBackend";
import { SessionControls } from "./SessionControls";
import { TransferDialog } from "./TransferDialog";

vi.mock("./controller", () => ({
  backendSessionId: () => "s1",
  focusActiveTerminal: vi.fn(),
}));

const serialTab: SessionTab = {
  id: "t1",
  title: "ttyUSB0 · 9600 8N1",
  protocol: "serial",
  state: "connected",
};

let backend: FakeBackend;

const wrapper = ({ children }: { children: ReactNode }) => (
  <TooltipProvider>{children}</TooltipProvider>
);

beforeEach(() => {
  backend = new FakeBackend("unlocked");
  useSessions.setState({ tabs: [serialTab], activeId: "t1" });
  useSerial.setState({ lines: {}, transfers: {}, dialogTab: null });
  useNotifications.setState({ items: [] });
});

afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 0));
  backend.dispose();
});

const callsTo = (cmd: string) => backend.calls.filter((c) => c.cmd === cmd).map((c) => c.args);

describe("serial header controls", () => {
  it("toggles DTR/RTS and sends BREAK", async () => {
    const user = userEvent.setup();
    render(<SessionControls tab={serialTab} />, { wrapper });
    const dtr = screen.getByRole("button", { name: "DTR" });
    expect(dtr).toHaveAttribute("aria-pressed", "true");
    await user.click(dtr);
    await waitFor(() => expect(dtr).toHaveAttribute("aria-pressed", "false"));
    expect(callsTo("serial_set_lines")).toEqual([{ id: "s1", dtr: false, rts: null }]);

    await user.click(screen.getByRole("button", { name: "RTS" }));
    expect(callsTo("serial_set_lines")[1]).toEqual({ id: "s1", dtr: null, rts: false });

    await user.click(screen.getByRole("button", { name: /Break/ }));
    expect(callsTo("session_break")).toEqual([{ id: "s1" }]);
  });

  it("offers only BREAK on Telnet and disables controls while offline", () => {
    const { rerender } = render(
      <SessionControls tab={{ ...serialTab, protocol: "telnet", title: "cs1" }} />,
      { wrapper },
    );
    expect(screen.queryByRole("button", { name: "DTR" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Transfer/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Break/ })).toBeEnabled();
    rerender(<SessionControls tab={{ ...serialTab, state: "disconnected" }} />);
    expect(screen.getByRole("button", { name: /Break/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "DTR" })).toBeDisabled();
    rerender(<SessionControls tab={{ ...serialTab, protocol: "ssh" }} />);
    expect(screen.queryByRole("button", { name: /Break/ })).toBeNull();
  });
});

describe("transfer dialog", () => {
  it("sends files with Ymodem and reports progress", async () => {
    const user = userEvent.setup();
    backend.dialogResult = ["/home/me/c2960-image.bin", "/home/me/config.txt"];
    render(
      <>
        <SessionControls tab={serialTab} />
        <TransferDialog />
      </>,
      { wrapper },
    );
    await user.click(screen.getByRole("button", { name: /Transfer/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Send file…" }));

    const dialog = await screen.findByRole("dialog", { name: "Send file" });
    expect(dialog).toBeVisible();
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Choose…" }));
    expect(await screen.findByText("c2960-image.bin, config.txt")).toBeVisible();

    // Xmodem cannot send several files.
    await user.click(screen.getByRole("radio", { name: "Xmodem" }));
    expect(screen.getByText(/Xmodem sends one file/)).toBeVisible();
    expect(send).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "Ymodem" }));

    await user.click(send);
    expect(await screen.findByText("Done: c2960-image.bin, config.txt (1.0 KiB)")).toBeVisible();
    expect(callsTo("serial_send_files")[0]).toMatchObject({
      id: "s1",
      variant: "ymodem",
      paths: ["/home/me/c2960-image.bin", "/home/me/config.txt"],
    });
    expect(useNotifications.getState().items[0]?.title).toBe("File sent");
    expect(useSerial.getState().transfers.t1?.phase).toBe("done");
  });

  it("receives into a chosen folder", async () => {
    const user = userEvent.setup();
    backend.dialogResult = "/home/me/Downloads";
    useSerial.getState().openDialog("t1", "receive");
    render(<TransferDialog />);
    await user.click(await screen.findByRole("radio", { name: "Xmodem-1K" }));
    await user.click(screen.getByRole("button", { name: "Choose…" }));
    expect(await screen.findByText("/home/me/Downloads")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Receive" }));
    expect(await screen.findByText("Done: fw.bin (2.0 KiB)")).toBeVisible();
    expect(callsTo("serial_receive_files")[0]).toMatchObject({
      id: "s1",
      variant: "xmodem1k",
      dir: "/home/me/Downloads",
    });
  });

  it("can cancel a running transfer", async () => {
    const user = userEvent.setup();
    useSerial.setState({
      dialogTab: "t1",
      dialogDirection: "send",
      transfers: {
        t1: {
          direction: "send",
          variant: "ymodem",
          phase: "running",
          bytes: 300,
          total: 1000,
          files: [],
        },
      },
    });
    render(<TransferDialog />);
    expect(await screen.findByRole("progressbar")).toHaveAttribute("aria-valuenow", "30");
    expect(screen.getByRole("button", { name: "Choose…" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancel transfer" }));
    expect(callsTo("serial_transfer_cancel")).toEqual([{ id: "s1" }]);
  });
});
