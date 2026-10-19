import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortInfo } from "@/lib/ipc";
import { QuickConnectDialog } from "@/ssh/QuickConnectDialog";
import { useUi } from "@/stores/ui";
import { FakeBackend } from "@/test/fakeBackend";
import { openSerial, openTelnet } from "@/terminal/controller";

vi.mock("@/terminal/controller", () => ({
  focusActiveTerminal: vi.fn(),
  openSsh: vi.fn(),
  openTelnet: vi.fn(),
  openSerial: vi.fn(),
}));

const usb = (path: string, label: string, chip: string | null = null): PortInfo => ({
  path,
  label,
  chip,
  vid: 0x0403,
  pid: 0x6001,
  serialNumber: null,
  usb: true,
});

let backend: FakeBackend;

beforeEach(() => {
  backend = new FakeBackend("unlocked");
  vi.mocked(openSerial).mockClear();
  vi.mocked(openTelnet).mockClear();
});

afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 0));
  backend.dispose();
  useUi.setState({ quickConnectOpen: false, connectProtocol: "ssh" });
});

describe("serial tab", () => {
  it("lists ports, follows hotplug and opens with the chosen line settings", async () => {
    backend.ports = [usb("/dev/ttyUSB0", "FTDI FT232R (A50285BI)", "FTDI FT232R")];
    const user = userEvent.setup();
    useUi.getState().openConnect("serial");
    render(<QuickConnectDialog />);

    const portSelect = await screen.findByLabelText("Port");
    await waitFor(() => expect(portSelect).toHaveValue("/dev/ttyUSB0"));
    expect(
      screen.getByRole("option", { name: "FTDI FT232R (A50285BI) — /dev/ttyUSB0" }),
    ).toBeVisible();
    // The first adapter is chosen automatically; its chip family is shown.
    expect(await screen.findByText("FTDI FT232R")).toBeVisible();

    // Plug in a second adapter: it shows up live with a notice.
    act(() =>
      backend.hotplug([...backend.ports, usb("/dev/ttyUSB1", "Prolific PL2303 (/dev/ttyUSB1)")]),
    );
    expect(await screen.findByText("ttyUSB1 connected")).toBeVisible();
    await user.selectOptions(portSelect, "/dev/ttyUSB1");

    // Unplugging the chosen adapter falls back to the remaining one.
    act(() => backend.hotplug([usb("/dev/ttyUSB0", "FTDI FT232R (A50285BI)")]));
    expect(await screen.findByText("ttyUSB1 disconnected")).toBeVisible();
    await waitFor(() => expect(portSelect).toHaveValue("/dev/ttyUSB0"));

    await user.selectOptions(screen.getByLabelText("Baud rate"), "115200");
    await user.selectOptions(screen.getByLabelText("Flow control"), "rts-cts");
    await user.selectOptions(screen.getByLabelText("Enter sends"), "crlf");
    await user.click(screen.getByRole("switch", { name: "Local echo" }));
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(openSerial).toHaveBeenCalledWith(
      {
        path: "/dev/ttyUSB0",
        settings: {
          baud: 115200,
          dataBits: "eight",
          parity: "none",
          stopBits: "one",
          flowControl: "rts-cts",
        },
        newline: { transmit: "crlf", receive: "crlf" },
        localEcho: true,
      },
      "ttyUSB0 · 115200 8N1",
      { vendor: "generic" },
    );
    // Closing the dialog stops the hotplug watch.
    await waitFor(() => expect(backend.portWatch).toBeNull());
  });

  it("accepts a custom path and baud rate when no port is found", async () => {
    const user = userEvent.setup();
    useUi.getState().openConnect("serial");
    render(<QuickConnectDialog />);

    expect(await screen.findByText(/No serial ports found/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Choose a serial port.")).toBeVisible();
    expect(openSerial).not.toHaveBeenCalled();

    await user.selectOptions(screen.getByLabelText("Port"), "Other path…");
    await user.type(screen.getByLabelText("Device path"), "/dev/ttyS4");
    await user.selectOptions(screen.getByLabelText("Baud rate"), "Other…");
    const baud = screen.getByLabelText("Baud rate");
    await user.clear(baud);
    await user.type(baud, "250000");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(openSerial).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/dev/ttyS4" }),
      "ttyS4 · 250000 8N1",
      { vendor: "generic" },
    );
  });
});

describe("telnet tab", () => {
  it("maps console-server ports and opens a session", async () => {
    const user = userEvent.setup();
    useUi.getState().openConnect("telnet");
    render(<QuickConnectDialog />);

    await user.type(await screen.findByLabelText("Destination"), "cs1.lab");
    await user.selectOptions(screen.getByLabelText("Console server type"), "avocent");
    const port = screen.getByLabelText("Port number");
    await user.clear(port);
    await user.type(port, "12");
    expect(screen.getByText("TCP 7012")).toBeVisible();
    await user.click(screen.getByRole("radio", { name: "Raw TCP" }));
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(openTelnet).toHaveBeenCalledWith(
      {
        host: "cs1.lab",
        port: 23,
        raw: true,
        console: { kind: "avocent", port: 12 },
        connectTimeoutSecs: 10,
      },
      "cs1.lab port 12",
      { vendor: "generic" },
    );
  });

  it("switches tabs from the keyboard without leaving the tab list", async () => {
    const user = userEvent.setup();
    useUi.getState().openConnect("ssh");
    render(<QuickConnectDialog />);
    await user.click(await screen.findByRole("tab", { name: "SSH" }));
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Telnet" })).toHaveFocus();
    expect(useUi.getState().connectProtocol).toBe("telnet");
    expect(screen.getByLabelText("Destination")).toHaveAttribute(
      "placeholder",
      "10.0.0.1 or cs1:2001",
    );
  });
});
