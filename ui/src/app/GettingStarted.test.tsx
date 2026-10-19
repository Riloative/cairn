import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDataDialog } from "@/stores/backupUi";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { FakeBackend } from "@/test/fakeBackend";
import { GettingStarted } from "./GettingStarted";

let backend: FakeBackend;

beforeEach(async () => {
  backend = new FakeBackend("unlocked");
  await act(() => useSettings.getState().load());
});

afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 0));
  backend.dispose();
  useUi.setState({ view: "sessions", quickConnectOpen: false, shortcutsOpen: false });
  useDataDialog.setState({ open: null });
});

describe("getting started", () => {
  it("leads to connecting, the inventory, a backup and the shortcuts, until hidden", async () => {
    const user = userEvent.setup();
    render(<GettingStarted />);
    await user.click(screen.getByRole("button", { name: /Connect to a device/ }));
    expect(useUi.getState().quickConnectOpen).toBe(true);
    await user.click(screen.getByRole("button", { name: /Build your inventory/ }));
    expect(useUi.getState().view).toBe("inventory");
    await user.click(screen.getByRole("button", { name: /Make a backup/ }));
    expect(useDataDialog.getState().open).toBe("backup");
    await user.click(screen.getByRole("button", { name: /Learn the shortcuts/ }));
    expect(useUi.getState().shortcutsOpen).toBe(true);

    await user.click(screen.getByRole("button", { name: "Hide getting started" }));
    await waitFor(() => expect(backend.settings.onboardingDone).toBe(true));
    expect(screen.queryByRole("heading", { name: "Get started" })).toBeNull();
  });
});
