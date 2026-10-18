import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useActions } from "@/lib/actions";
import { useNotifications } from "@/stores/notifications";
import { useSessions } from "@/stores/sessions";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { useVault } from "@/stores/vault";
import { FakeBackend } from "@/test/fakeBackend";
import { App } from "./App";

let backend: FakeBackend;

function resetStores() {
  useVault.setState({ info: null, lockReason: null });
  useSettings.setState({ settings: null });
  useUi.setState({ view: "sessions", paletteOpen: false, notificationsOpen: false });
  useNotifications.setState({ items: [] });
  useSessions.setState({ tabs: [], activeId: null });
  useActions.setState({ actions: new Map() });
}

beforeEach(resetStores);
afterEach(async () => {
  // Unmount and let async unlisten calls settle before removing the IPC mock.
  cleanup();
  await new Promise((r) => setTimeout(r, 0));
  backend.dispose();
});

describe("first launch", () => {
  it("requires a strong, confirmed password and the no-recovery acknowledgment", async () => {
    backend = new FakeBackend("uninitialized");
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Create a master password" })).toBeVisible();
    const submit = screen.getByRole("button", { name: "Create vault" });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText("Master password"), "glacier-tandem-orbit-velvet");
    await user.type(screen.getByLabelText("Confirm password"), "glacier-tandem-orbit-velvet");
    await waitFor(() =>
      expect(screen.getByRole("meter", { name: "Password strength" })).toHaveAttribute(
        "aria-valuenow",
        "4",
      ),
    );
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(await screen.findByRole("navigation", { name: "Sections" })).toBeVisible();
    expect(backend.calls.find((c) => c.cmd === "vault_setup")?.args.password).toBe(
      "glacier-tandem-orbit-velvet",
    );
  });

  it("flags mismatched confirmation", async () => {
    backend = new FakeBackend("uninitialized");
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("Master password"), "glacier-tandem-orbit");
    await user.type(screen.getByLabelText("Confirm password"), "glacier-tandem-orbiX");
    expect(screen.getByText("Passwords do not match.")).toBeVisible();
  });
});

describe("lock screen", () => {
  it("shows the backend's message for a wrong password and the failed-attempt count", async () => {
    backend = new FakeBackend("locked");
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("Master password"), "nope nope nope");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByText("The master password is incorrect.")).toBeVisible();
    expect(screen.getByText(/1 failed attempt/)).toBeVisible();
  });

  it("unlocks into the shell", async () => {
    backend = new FakeBackend("locked");
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("Master password"), backend.password);
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByRole("heading", { name: "No open sessions" })).toBeVisible();
  });

  it("returns to the lock screen when the backend auto-locks", async () => {
    backend = new FakeBackend("unlocked");
    render(<App />);
    await screen.findByRole("navigation", { name: "Sections" });
    await act(() => backend.autoLock("idle"));
    expect(await screen.findByText("Cairn locked after a period of inactivity.")).toBeVisible();
  });
});

describe("shell", () => {
  beforeEach(() => {
    backend = new FakeBackend("unlocked");
  });

  it("navigates between sections from the sidebar", async () => {
    const user = userEvent.setup();
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Sections" });
    await user.click(within(nav).getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeVisible();
    await user.click(within(nav).getByRole("button", { name: "Audit" }));
    expect(await screen.findByRole("heading", { name: "Audit log" })).toBeVisible();
  });

  it("opens the command palette with the shortcut and runs an action", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("navigation", { name: "Sections" });
    await user.keyboard("{Control>}k{/Control}");
    const input = await screen.findByPlaceholderText("Type a command or search…");
    await user.type(input, "go to audit");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { name: "Audit log" })).toBeVisible();
    expect(screen.queryByPlaceholderText("Type a command or search…")).toBeNull();
  });

  it("changes the theme from settings and persists it via IPC", async () => {
    const user = userEvent.setup();
    useUi.setState({ view: "settings" });
    render(<App />);
    await user.click(await screen.findByRole("radio", { name: "Sand" }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("sand"));
    expect(backend.settings.theme).toBe("sand");
  });

  it("locks from the sidebar", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Lock" }));
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeVisible();
    expect(backend.status).toBe("locked");
  });

  it("verifies the audit chain and reports it as a toast", async () => {
    const user = userEvent.setup();
    useUi.setState({ view: "audit" });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Verify integrity" }));
    expect(await screen.findByText("Audit log intact")).toBeVisible();
  });

  it("lists shortcuts in settings", async () => {
    const user = userEvent.setup();
    useUi.setState({ view: "settings" });
    render(<App />);
    await user.click(await screen.findByRole("tab", { name: "Shortcuts" }));
    expect(await screen.findByText("Command palette")).toBeVisible();
    expect(screen.getByText("Lock Cairn")).toBeVisible();
  });

  it("edits and saves a terminal profile", async () => {
    const user = userEvent.setup();
    useUi.setState({ view: "settings" });
    render(<App />);
    await user.click(await screen.findByRole("tab", { name: "Terminal" }));
    const size = await screen.findByLabelText("Font size");
    await user.clear(size);
    await user.type(size, "15");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(backend.terminalPrefs.profiles[0]?.fontSize).toBe(15));
  });

  it("validates privileged prompt patterns before saving", async () => {
    const user = userEvent.setup();
    useUi.setState({ view: "settings" });
    render(<App />);
    await user.click(await screen.findByRole("tab", { name: "Terminal" }));
    const area = await screen.findByLabelText("Privileged prompt patterns");
    await user.clear(area);
    await user.type(area, "(unclosed");
    expect(await screen.findByText(/Line 1:/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save patterns" })).toBeDisabled();
  });

  it("shows session tabs with protocol and state", async () => {
    useSessions.setState({
      tabs: [{ id: "a", title: "core-sw1", protocol: "ssh", state: "connected" }],
      activeId: "a",
    });
    render(<App />);
    const tab = await screen.findByRole("tab", { name: /core-sw1/ });
    expect(within(tab).getByRole("img", { name: "Connected" })).toBeInTheDocument();
  });
});
