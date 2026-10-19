import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SavedList } from "@/app/SavedList";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { QuickConnectDialog } from "@/ssh/QuickConnectDialog";
import { useInventory } from "@/stores/inventory";
import { useNotifications } from "@/stores/notifications";
import { useSavedConnections } from "@/stores/savedConnections";
import { useUi } from "@/stores/ui";
import { openRdp } from "@/rdp/controller";
import { openSsh } from "@/terminal/controller";
import { FakeBackend } from "@/test/fakeBackend";

vi.mock("@/terminal/controller", () => ({
  openSsh: vi.fn(),
  openTelnet: vi.fn(),
  openSerial: vi.fn(),
  focusActiveTerminal: vi.fn(),
}));
vi.mock("@/rdp/controller", () => ({ openRdp: vi.fn() }));

let backend: FakeBackend;

function renderAll() {
  return render(
    <TooltipProvider>
      <SavedList />
      <QuickConnectDialog />
      <ConfirmDialog />
    </TooltipProvider>,
  );
}

let profileId = 0;

beforeEach(async () => {
  backend = new FakeBackend("unlocked");
  profileId = backend.inventory.saveCredential({
    id: 0,
    name: "netops",
    username: "admin",
    keyPath: null,
    autoEnable: true,
    notes: "",
    password: { action: "set", value: "s3cret" },
    keyData: { action: "keep" },
    keyPassphrase: { action: "keep" },
    enableSecret: { action: "keep" },
  }).id;
  useUi.setState({ quickConnectOpen: false, editingSaved: null, connectProtocol: "ssh" });
  useSavedConnections.setState({ list: null });
  useNotifications.setState({ items: [] });
  await act(() => useInventory.getState().load());
  vi.mocked(openSsh).mockClear();
  vi.mocked(openRdp).mockClear();
});

afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 0));
  backend.dispose();
});

describe("saved connections", () => {
  it("saves a Quick Connect target without its password and reopens it in one click", async () => {
    const user = userEvent.setup();
    renderAll();
    act(() => useUi.getState().openConnect("ssh"));
    const dialog = await screen.findByRole("dialog", { name: "New connection" });
    await user.type(within(dialog).getByLabelText("Destination"), "10.0.0.1:2222");
    await user.type(within(dialog).getByLabelText("Password"), "typed-once");

    await user.click(within(dialog).getByRole("button", { name: "Save…" }));
    const save = within(dialog).getByRole("group", { name: "Save connection" });
    expect(within(save).getByLabelText("Name")).toHaveValue("10.0.0.1");
    await user.clear(within(save).getByLabelText("Name"));
    await user.type(within(save).getByLabelText("Name"), "core-sw1");
    // With a credential profile the username may come from it.
    await user.selectOptions(within(save).getByLabelText("Credential profile"), "netops (admin)");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(backend.saved).toHaveLength(1));
    const stored = backend.saved[0];
    expect(stored).toMatchObject({ name: "core-sw1", protocol: "ssh", credentialId: profileId });
    expect(stored?.settings).toMatchObject({ destination: "10.0.0.1:2222" });
    expect(JSON.stringify(stored?.settings)).not.toContain("typed-once");
    expect(screen.queryByRole("dialog")).toBeNull();

    // The sidebar lists it; a click opens it with the profile, resolved in Rust.
    const list = await screen.findByRole("region", { name: "Saved connections" });
    await user.click(within(list).getByRole("button", { name: "core-sw1" }));
    expect(openSsh).toHaveBeenCalledTimes(1);
    const [options, title, extra] = vi.mocked(openSsh).mock.calls[0] ?? [];
    expect(title).toBe("core-sw1");
    expect(extra).toMatchObject({ credentialId: profileId });
    expect(options?.hops.at(-1)).toMatchObject({ host: "10.0.0.1", port: 2222, username: "" });
    await waitFor(() => expect(backend.saved[0]?.lastUsedAt).not.toBeNull());
  });

  it("edits and deletes a saved connection", async () => {
    backend.saved = [
      {
        id: 5,
        name: "branch-rdp",
        protocol: "rdp",
        settings: { destination: "10.9.0.5", username: "ops" },
        credentialId: null,
        lastUsedAt: null,
      },
    ];
    const user = userEvent.setup();
    renderAll();
    await act(() => useSavedConnections.getState().load());
    const list = screen.getByRole("region", { name: "Saved connections" });

    await user.click(within(list).getByRole("button", { name: "Actions for branch-rdp" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit…" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit branch-rdp" });
    expect(within(dialog).getByRole("tab", { name: "RDP" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(dialog).getByLabelText("Destination")).toHaveValue("10.9.0.5");
    const name = within(dialog).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "branch-dc");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(backend.saved[0]?.name).toBe("branch-dc"));
    expect(backend.saved).toHaveLength(1);

    await user.click(
      within(screen.getByRole("region", { name: "Saved connections" })).getByRole("button", {
        name: "Actions for branch-dc",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Delete…" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(backend.saved).toHaveLength(0));
    expect(screen.queryByRole("region", { name: "Saved connections" })).toBeNull();
  });
});
