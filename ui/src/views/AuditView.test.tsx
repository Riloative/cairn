import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TooltipProvider } from "@/components/ui/Tooltip";
import type { AuditEntry } from "@/lib/ipc";
import { EMPTY_AUDIT_FILTER, toAuditFilter, useAuditView } from "@/stores/auditView";
import { useSettings } from "@/stores/settings";
import { FakeBackend } from "@/test/fakeBackend";
import { AuditView } from "./AuditView";
import { SettingsView } from "./settings/SettingsView";

let backend: FakeBackend;

function entry(
  seq: number,
  ts: string,
  kind: string,
  payload: Record<string, unknown>,
): AuditEntry {
  return {
    seq,
    ts,
    kind,
    payload: { kind, ...payload },
    prevHash: "0".repeat(64),
    hash: String(seq).padStart(64, "a"),
  };
}

beforeEach(() => {
  backend = new FakeBackend("unlocked");
  // Newest first, like the fake's own log.
  backend.audit = [
    entry(6, "2026-01-04T08:00:00.000Z", "inventory_changed", {
      entity: "device",
      entityId: 1,
      name: "sw1",
      action: "updated",
      changes: [],
    }),
    entry(5, "2026-01-03T09:05:00.000Z", "session_ended", {
      sessionId: "s2",
      protocol: "telnet",
      target: "fw1:23",
      durationSecs: 300,
      reason: "closed by user",
    }),
    entry(4, "2026-01-03T09:00:00.000Z", "session_started", {
      sessionId: "s2",
      protocol: "telnet",
      target: "fw1:23",
      device: "fw1",
    }),
    entry(3, "2026-01-02T10:01:00.000Z", "file_transferred", {
      sessionId: "s1",
      protocol: "sftp",
      direction: "download",
      file: "startup.cfg",
      bytes: 10,
      ok: true,
    }),
    entry(2, "2026-01-02T10:00:00.000Z", "session_started", {
      sessionId: "s1",
      protocol: "ssh",
      target: "10.0.0.1:22",
      device: "sw1",
    }),
    entry(1, "2026-01-01T00:00:00.000Z", "vault_created", {}),
  ];
});

afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 0));
  backend.dispose();
  useAuditView.getState().reset();
});

const rows = () => screen.getAllByRole("button", { name: /^Details of entry/ });

describe("audit view", () => {
  it("filters by device through its sessions, by protocol and by text", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <AuditView />
      </TooltipProvider>,
    );
    expect(await screen.findByText("6 entries")).toBeVisible();

    await user.selectOptions(screen.getByLabelText("Device"), "sw1");
    // The session start, the SFTP transfer inside it and the inventory change.
    expect(await screen.findByText("3 matching")).toBeVisible();
    expect(rows().map((r) => r.getAttribute("aria-label"))).toEqual([
      "Details of entry 6",
      "Details of entry 3",
      "Details of entry 2",
    ]);

    await user.selectOptions(screen.getByLabelText("Device"), "");
    await user.selectOptions(screen.getByLabelText("Protocol"), "telnet");
    expect(await screen.findByText("2 matching")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Clear" }));
    await user.type(screen.getByLabelText("Search the audit log"), "startup");
    expect(await screen.findByText("1 matching")).toBeVisible();
    expect(screen.getByText(/startup\.cfg received/)).toBeVisible();

    // Expanding an entry shows its fields and hashes.
    await user.click(screen.getByRole("button", { name: "Details of entry 3" }));
    expect(screen.getByText("download")).toBeVisible();
    expect(screen.getByText("previous hash")).toBeVisible();
  });

  it("exports what is shown and offers to clear filters that match nothing", async () => {
    const user = userEvent.setup();
    backend.dialogResult = "/tmp/audit.csv";
    render(
      <TooltipProvider>
        <AuditView />
      </TooltipProvider>,
    );
    expect(await screen.findByText("6 entries")).toBeVisible();
    await user.selectOptions(screen.getByLabelText("Protocol"), "ssh");
    expect(await screen.findByText("2 matching")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(await screen.findByRole("menuitem", { name: "CSV (spreadsheet)" }));
    await waitFor(() =>
      expect(backend.exports).toEqual([{ what: "audit", format: "csv", path: "/tmp/audit.csv" }]),
    );
    const call = backend.calls.find((c) => c.cmd === "audit_export");
    expect(call?.args.filter).toMatchObject({ protocol: "ssh" });

    await user.type(screen.getByLabelText("Search the audit log"), "nothing-like-this");
    expect(await screen.findByText("No matching entries")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByText("6 entries")).toBeVisible();
  });

  it("turns time ranges into backend bounds", () => {
    const now = Date.parse("2026-01-10T12:00:00Z");
    expect(toAuditFilter({ ...EMPTY_AUDIT_FILTER, range: "24h" }, now).from).toBe(
      "2026-01-09T12:00:00.000Z",
    );
    const custom = toAuditFilter(
      { ...EMPTY_AUDIT_FILTER, range: "custom", customFrom: "2026-01-02", customTo: "2026-01-02" },
      now,
    );
    // The end date is inclusive: the bound is the next local midnight.
    expect(Date.parse(custom.to ?? "") - Date.parse(custom.from ?? "")).toBe(24 * 3_600_000);
    expect(toAuditFilter(EMPTY_AUDIT_FILTER, now)).toMatchObject({
      from: null,
      to: null,
      text: null,
    });
  });
});

describe("audit retention setting", () => {
  it("asks before a shorter retention removes entries", async () => {
    const user = userEvent.setup();
    await act(() => useSettings.getState().load());
    render(
      <TooltipProvider>
        <SettingsView />
        <ConfirmDialog />
      </TooltipProvider>,
    );
    await user.click(await screen.findByRole("tab", { name: "Security" }));
    const select = await screen.findByLabelText("Audit retention");
    await user.selectOptions(select, "365");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Keep the audit log for 1 year?")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(backend.settings.auditRetentionDays).toBe(0);

    await user.selectOptions(select, "365");
    await user.click(await screen.findByRole("button", { name: "Remove older entries" }));
    await waitFor(() => expect(backend.settings.auditRetentionDays).toBe(365));

    // Keeping entries longer needs no confirmation.
    await user.selectOptions(select, "0");
    await waitFor(() => expect(backend.settings.auditRetentionDays).toBe(0));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
