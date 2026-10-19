import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { useNotifications } from "@/stores/notifications";
import { useDataDialog } from "@/stores/backupUi";
import { useSessions } from "@/stores/sessions";
import { useSettings } from "@/stores/settings";
import { useVault } from "@/stores/vault";
import { FakeBackend } from "@/test/fakeBackend";
import { SetupScreen } from "@/screens/SetupScreen";
import { SettingsView } from "@/views/settings/SettingsView";
import { DataDialogs } from "./DataDialogs";
import { reloadApp } from "./reload";

vi.mock("./reload", () => ({ reloadApp: vi.fn() }));

const MASTER = "correct horse battery";
const STRONG = "glacier-tandem-orbit-velvet";

let backend: FakeBackend;

afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 0));
  backend.dispose();
  vi.mocked(reloadApp).mockClear();
  useSessions.setState({ tabs: [], activeId: null });
  useVault.setState({ info: null, justCreated: false });
  useDataDialog.setState({ open: null });
});

async function openBackupTab() {
  const user = userEvent.setup();
  await act(() => useSettings.getState().load());
  await act(() => useVault.getState().refresh());
  render(
    <TooltipProvider>
      <SettingsView />
      <DataDialogs />
    </TooltipProvider>,
  );
  await user.click(await screen.findByRole("tab", { name: "Backup" }));
  return user;
}

describe("backup in settings", () => {
  beforeEach(() => {
    backend = new FakeBackend("unlocked");
  });

  it("creates a backup with a strong, confirmed password", async () => {
    const user = await openBackupTab();
    backend.dialogResult = "/home/me/cairn.cairn-backup";
    await user.click(screen.getByRole("button", { name: "Create backup…" }));
    const dialog = await screen.findByRole("dialog", { name: "Create a backup" });
    await user.type(within(dialog).getByLabelText("Backup password"), STRONG);
    await user.type(within(dialog).getByLabelText("Confirm password"), STRONG);
    await user.click(within(dialog).getByRole("switch", { name: "Include session recordings" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("meter")).toHaveAttribute("aria-valuenow", "4"),
    );
    await user.click(within(dialog).getByRole("button", { name: "Choose location and save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const call = backend.calls.find((c) => c.cmd === "backup_create");
    expect(call?.args).toEqual({
      path: "/home/me/cairn.cairn-backup",
      password: STRONG,
      recordings: false,
    });
    expect(useNotifications.getState().items[0]?.title).toBe("Backup saved");
  });

  it("restores only with no open sessions and the right passwords, then reloads", async () => {
    useSessions.setState({
      tabs: [{ id: "t1", title: "sw1", protocol: "ssh", state: "connected" }],
      activeId: "t1",
    });
    const user = await openBackupTab();
    backend.dialogResult = "/home/me/old.cairn-backup";
    await user.click(screen.getByRole("button", { name: "Restore…" }));
    const dialog = await screen.findByRole("dialog", { name: "Restore a backup" });
    await user.click(within(dialog).getByRole("button", { name: "Choose…" }));
    expect(await within(dialog).findByText("old.cairn-backup")).toBeVisible();
    expect(within(dialog).getByText(/with recordings/)).toBeVisible();
    await user.type(within(dialog).getByLabelText("Backup password"), backend.backupPassword);
    await user.type(within(dialog).getByLabelText("Your master password"), "wrong master pw");
    const replace = within(dialog).getByRole("button", { name: "Replace everything" });
    expect(within(dialog).getByText("Close all sessions before restoring.")).toBeVisible();
    expect(replace).toBeDisabled();

    act(() => useSessions.setState({ tabs: [], activeId: null }));
    await user.click(replace);
    expect(
      await within(dialog).findByText("The backup password or your master password is wrong."),
    ).toBeVisible();
    expect(reloadApp).not.toHaveBeenCalled();

    await user.clear(within(dialog).getByLabelText("Your master password"));
    await user.type(within(dialog).getByLabelText("Your master password"), MASTER);
    await user.click(replace);
    await waitFor(() => expect(reloadApp).toHaveBeenCalled());
    expect(backend.restoredFrom).toBe("/home/me/old.cairn-backup");
  });

  it("rejects files that are not backups", async () => {
    const user = await openBackupTab();
    backend.dialogResult = "/home/me/notes.txt";
    await user.click(screen.getByRole("button", { name: "Restore…" }));
    const dialog = await screen.findByRole("dialog", { name: "Restore a backup" });
    await user.click(within(dialog).getByRole("button", { name: "Choose…" }));
    expect(await within(dialog).findByText("This file is not a Cairn backup.")).toBeVisible();
    expect(within(dialog).queryByLabelText("Backup password")).toBeNull();
  });
});

describe("restore on first launch", () => {
  it("sets a new master password while restoring", async () => {
    backend = new FakeBackend("uninitialized");
    const user = userEvent.setup();
    await act(() => useVault.getState().refresh());
    render(<SetupScreen />);
    backend.dialogResult = "/media/usb/cairn.cairn-backup";
    await user.click(screen.getByRole("button", { name: "Restore from a backup" }));
    const dialog = await screen.findByRole("dialog", { name: "Restore a backup" });
    await user.click(within(dialog).getByRole("button", { name: "Choose…" }));
    await user.type(
      await within(dialog).findByLabelText("Backup password"),
      backend.backupPassword,
    );
    await user.type(within(dialog).getByLabelText("New master password"), STRONG);
    await user.type(within(dialog).getByLabelText("Confirm master password"), STRONG);
    const restore = within(dialog).getByRole("button", { name: "Restore" });
    await waitFor(() => expect(restore).toBeEnabled());
    await user.click(restore);
    await waitFor(() => expect(reloadApp).toHaveBeenCalled());
    expect(backend.password).toBe(STRONG);
    expect(useVault.getState().info?.status).toBe("unlocked");
  });
});

describe("inventory export", () => {
  beforeEach(() => {
    backend = new FakeBackend("unlocked");
  });

  it("exports CSV without credentials, and with them only after the warning is confirmed", async () => {
    const user = await openBackupTab();
    backend.dialogResult = "/home/me/inv";
    await user.click(screen.getByRole("button", { name: "Export…" }));
    let dialog = await screen.findByRole("dialog", { name: "Export inventory" });
    await user.click(within(dialog).getByRole("radio", { name: "CSV (a folder of tables)" }));
    await user.click(within(dialog).getByRole("button", { name: "Export" }));
    await waitFor(() =>
      expect(backend.exports).toEqual([{ what: "inventory", format: "csv", path: "/home/me/inv" }]),
    );
    expect(useNotifications.getState().items[0]?.description).toBe("5 files in /home/me/inv");

    await user.click(screen.getByRole("button", { name: "Export…" }));
    dialog = await screen.findByRole("dialog", { name: "Export inventory" });
    await user.click(within(dialog).getByRole("switch", { name: "Include credentials" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/plain text/);
    const go = within(dialog).getByRole("button", { name: "Export with secrets" });
    expect(go).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(go);
    await waitFor(() => expect(backend.exports).toHaveLength(2));
    expect(backend.exports[1]).toMatchObject({ what: "inventory+credentials", format: "json" });
    expect(backend.audit[0]?.payload.what).toBe("inventory with credentials and their secrets");
  });
});
