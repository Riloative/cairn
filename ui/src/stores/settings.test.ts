import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeBackend } from "@/test/fakeBackend";
import { useSettings } from "./settings";

let backend: FakeBackend;

beforeEach(async () => {
  backend = new FakeBackend("unlocked");
  useSettings.setState({ settings: null });
  await useSettings.getState().load();
});

afterEach(() => backend.dispose());

const updates = () => backend.calls.filter((c) => c.cmd === "settings_update");

describe("settings store", () => {
  it("persists two rapid updates instead of letting the later one revert the earlier", async () => {
    const s = useSettings.getState();
    // Neither call awaits the other: the second starts while the first save is in flight.
    const first = s.update({ sidebarCollapsed: true });
    const second = s.update({ theme: "sand" });
    await Promise.all([first, second]);
    expect(backend.settings).toMatchObject({ sidebarCollapsed: true, theme: "sand" });
    expect(useSettings.getState().settings).toMatchObject({
      sidebarCollapsed: true,
      theme: "sand",
    });
    // The second save was built on the first one's result, not on the stale state.
    expect(
      updates().map((c) => (c.args.settings as { sidebarCollapsed: boolean }).sidebarCollapsed),
    ).toEqual([true, true]);
    expect(document.documentElement.dataset.theme).toBe("sand");
  });

  it("rejects the failed update only and keeps the queue moving", async () => {
    const s = useSettings.getState();
    backend.status = "locked";
    const failed = s.update({ onboardingDone: true });
    // Let the queued save reach the (locked) backend before the next one is queued.
    await Promise.resolve();
    expect(updates()).toHaveLength(1);
    backend.status = "unlocked";
    const next = s.update({ autoLockMinutes: 5 });
    await expect(failed).rejects.toMatchObject({ code: "vault.locked" });
    await next;
    expect(useSettings.getState().settings).toMatchObject({
      onboardingDone: false,
      autoLockMinutes: 5,
    });
    expect(backend.settings.autoLockMinutes).toBe(5);
  });

  it("does nothing before settings are loaded", async () => {
    useSettings.setState({ settings: null });
    await useSettings.getState().update({ theme: "sand" });
    expect(updates()).toHaveLength(0);
  });
});
