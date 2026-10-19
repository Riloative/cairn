import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TooltipProvider } from "@/components/ui/Tooltip";
import type { RecordingInfo } from "@/lib/ipc";
import { useAuditView } from "@/stores/auditView";
import { FakeBackend } from "@/test/fakeBackend";
import { AuditView } from "@/views/AuditView";

/** What the stub terminal was asked to draw. */
const drawn = vi.hoisted(() => ({ text: "" }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    open() {}
    write(d: string) {
      drawn.text += d;
    }
    reset() {
      drawn.text = "";
    }
    resize() {}
    dispose() {}
  },
}));

let backend: FakeBackend;

const info = (id: number, device: string, startedAt: string): RecordingInfo => ({
  id,
  sessionId: `s${id}`,
  protocol: "ssh",
  target: "10.0.0.1:22",
  deviceId: id,
  device,
  cols: 80,
  rows: 24,
  startedAt,
  endedAt: startedAt,
  durationMs: 65_000,
  bytes: 2048,
  truncated: false,
});

const cast = [
  JSON.stringify({ version: 2, width: 80, height: 24 }),
  JSON.stringify([0.1, "o", "sw1# show clock\r\n"]),
  JSON.stringify([0.2, "o", "10:00:00 UTC\r\n"]),
].join("\n");

beforeEach(() => {
  backend = new FakeBackend("unlocked");
  drawn.text = "";
  backend.recordings = [
    { info: info(2, "sw1", "2026-01-03T10:00:00.000Z"), cast },
    { info: info(1, "fw1", "2026-01-02T10:00:00.000Z"), cast },
  ];
  useAuditView.getState().setSection("recordings");
});

afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 0));
  backend.dispose();
  useAuditView.setState({ section: "log" });
});

function renderView() {
  return render(
    <TooltipProvider>
      <AuditView />
      <ConfirmDialog />
    </TooltipProvider>,
  );
}

describe("recordings", () => {
  it("lists, searches, replays, exports and deletes recordings", async () => {
    const user = userEvent.setup();
    backend.dialogResult = "/tmp/sw1.cast";
    renderView();
    expect(await screen.findByText("2 recordings")).toBeVisible();
    expect(screen.getAllByText("1:05")).toHaveLength(2);

    await user.type(screen.getByLabelText("Search recordings"), "fw");
    expect(await screen.findByText("1 recording")).toBeVisible();
    await user.clear(screen.getByLabelText("Search recordings"));

    // Play: the cast is fetched and drawn into the terminal.
    await user.click(screen.getByRole("button", { name: "Play recording of sw1" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("sw1 · SSH")).toBeVisible();
    const position = await within(dialog).findByLabelText("Position");
    await waitFor(() => expect(position).toBeEnabled());
    // Seeking to the end draws everything; back to the start clears the screen.
    fireEvent.change(position, { target: { value: "1" } });
    expect(drawn.text).toContain("10:00:00 UTC");
    expect(within(dialog).getByText("0:00 / 0:00")).toBeVisible();
    fireEvent.change(position, { target: { value: "0" } });
    expect(drawn.text).toBe("");
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "More actions for sw1" }));
    await user.click(await screen.findByRole("menuitem", { name: "Export as asciicast (.cast)" }));
    await waitFor(() =>
      expect(backend.exports).toEqual([
        { what: "recording 2", format: "cast", path: "/tmp/sw1.cast" },
      ]),
    );

    await user.click(screen.getByRole("button", { name: "More actions for fw1" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete recording…" }));
    await user.click(await screen.findByRole("button", { name: "Delete recording" }));
    expect(await screen.findByText("1 recording")).toBeVisible();
    expect(backend.audit[0]?.kind).toBe("recording_deleted");
  });

  it("explains how to turn recording on when there are none", async () => {
    backend.recordings = [];
    renderView();
    expect(await screen.findByText("No recordings yet")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open settings" })).toBeVisible();
  });
});
