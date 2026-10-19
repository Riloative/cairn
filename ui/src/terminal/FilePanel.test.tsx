import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { useFiles } from "@/stores/files";
import type { SessionTab } from "@/stores/sessions";
import { FakeBackend } from "@/test/fakeBackend";
import { FilePanel } from "./FilePanel";

let backend: FakeBackend;
const tab: SessionTab = { id: "t1", title: "srv1", protocol: "ssh", state: "connected" };

beforeEach(() => {
  backend = new FakeBackend("unlocked");
  useFiles.setState({ panels: {}, queue: [] });
});

afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 0));
  backend.dispose();
});

function renderPanel() {
  render(
    <TooltipProvider>
      <FilePanel tab={tab} sessionId="s1" />
      <ConfirmDialog />
    </TooltipProvider>,
  );
  act(() => useFiles.getState().toggle("t1", "s1"));
}

const rows = () =>
  within(screen.getByRole("listbox", { name: "Remote files" }))
    .queryAllByRole("option")
    .map((o) => o.textContent);

describe("file panel", () => {
  it("browses, creates folders, renames and deletes", async () => {
    const user = userEvent.setup();
    renderPanel();
    expect(await screen.findByDisplayValue("/home/admin")).toBeInTheDocument();
    expect(rows()).toEqual([
      expect.stringContaining("configs"),
      expect.stringContaining("notes.txt"),
    ]);

    await user.click(screen.getByRole("button", { name: "New folder" }));
    const dialog = await screen.findByRole("dialog", { name: "New folder" });
    await user.type(within(dialog).getByLabelText("Name"), "backups");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(rows()).toHaveLength(3));

    await user.pointer({ keys: "[MouseRight]", target: screen.getByText("notes.txt") });
    await user.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const rename = await screen.findByRole("dialog", { name: "Rename notes.txt" });
    const name = within(rename).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "readme.txt");
    await user.click(within(rename).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("readme.txt")).toBeInTheDocument();

    await user.pointer({ keys: "[MouseRight]", target: screen.getByText("readme.txt") });
    await user.click(await screen.findByRole("menuitem", { name: "Permissions…" }));
    const chmod = await screen.findByRole("dialog", { name: "Permissions of readme.txt" });
    const mode = within(chmod).getByLabelText("Permissions (octal)");
    await user.clear(mode);
    await user.type(mode, "9");
    expect(within(chmod).getByRole("button", { name: "Save" })).toBeDisabled();
    await user.clear(mode);
    await user.type(mode, "600");
    await user.click(within(chmod).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(backend.remoteFs?.["/home/admin"]?.find((e) => e.name === "readme.txt")?.mode).toBe(
        0o600,
      ),
    );

    await user.pointer({ keys: "[MouseRight]", target: screen.getByText("readme.txt") });
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("readme.txt")).not.toBeInTheDocument());

    await user.dblClick(screen.getByText("configs"));
    expect(await screen.findByDisplayValue("/home/admin/configs")).toBeInTheDocument();
    expect(await screen.findByText("This folder is empty.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Up one folder" }));
    expect(await screen.findByDisplayValue("/home/admin")).toBeInTheDocument();
  });

  it("queues uploads and downloads and shows them as done", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("notes.txt");
    backend.dialogResult = ["/tmp/a.bin", "/tmp/b.bin"];
    await user.click(screen.getByRole("button", { name: "Upload files" }));
    const queue = await screen.findByRole("region", { name: "Transfers" });
    await waitFor(() => expect(within(queue).getAllByText("done")).toHaveLength(2));
    expect(backend.transfers.map((t) => [t.direction, t.remotePath])).toEqual([
      ["upload", "/home/admin/a.bin"],
      ["upload", "/home/admin/b.bin"],
    ]);
    // The folder refreshes after uploads into it.
    await waitFor(() => expect(rows()).toContainEqual(expect.stringContaining("a.bin")));

    backend.dialogResult = "/home/me/notes.txt";
    await user.dblClick(screen.getByText("notes.txt"));
    await waitFor(() => expect(backend.transfers).toHaveLength(3));
    expect(backend.transfers[2]).toMatchObject({
      protocol: "sftp",
      direction: "download",
      localPath: "/home/me/notes.txt",
      remotePath: "/home/admin/notes.txt",
    });
  });

  it("falls back to SCP when the device has no SFTP", async () => {
    backend.remoteFs = null;
    const user = userEvent.setup();
    renderPanel();
    const remote = await screen.findByLabelText("Remote path");
    expect(screen.getByText(/SFTP is not available/)).toBeVisible();
    await user.type(remote, "flash:");
    backend.dialogResult = "/images/c2960.bin";
    await user.click(screen.getByRole("button", { name: /Upload/ }));
    await waitFor(() => expect(backend.transfers).toHaveLength(1));
    expect(backend.transfers[0]).toMatchObject({
      protocol: "scp",
      direction: "upload",
      remotePath: "flash:c2960.bin",
    });
  });
});
