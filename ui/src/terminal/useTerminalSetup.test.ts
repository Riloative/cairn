import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "@/stores/settings";
import { useTerminalPrefs, DEFAULT_TERMINAL_PREFS } from "@/stores/terminalPrefs";
import { DEFAULT_SETTINGS, FakeBackend } from "@/test/fakeBackend";
import { refreshTerminals } from "./controller";
import { terminalSettingsChanged, useTerminalSetup } from "./useTerminalSetup";

vi.mock("./controller", () => ({
  refreshTerminals: vi.fn(),
  openLocalShell: vi.fn(),
}));

let backend: FakeBackend;

beforeEach(() => {
  backend = new FakeBackend("unlocked");
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  useTerminalPrefs.setState({ prefs: DEFAULT_TERMINAL_PREFS, loaded: false });
  vi.mocked(refreshTerminals).mockClear();
  // The restyle is deferred to the next frame; run it synchronously here.
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 0;
  });
});

afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 0));
  backend.dispose();
  vi.restoreAllMocks();
});

describe("terminalSettingsChanged", () => {
  it("only reacts to the fields that decide the app theme", () => {
    const base = { ...DEFAULT_SETTINGS };
    expect(terminalSettingsChanged(base, base)).toBe(false);
    expect(terminalSettingsChanged({ ...base, sidebarCollapsed: true }, base)).toBe(false);
    expect(terminalSettingsChanged({ ...base, onboardingDone: true }, base)).toBe(false);
    expect(terminalSettingsChanged({ ...base, autoLockMinutes: 1 }, base)).toBe(false);
    expect(terminalSettingsChanged({ ...base, theme: "sand" }, base)).toBe(true);
    expect(terminalSettingsChanged({ ...base, systemDarkTheme: "obsidian" }, base)).toBe(true);
    expect(terminalSettingsChanged({ ...base, systemLightTheme: "sand" }, base)).toBe(true);
    expect(terminalSettingsChanged(null, base)).toBe(true);
    expect(terminalSettingsChanged(base, null)).toBe(true);
    expect(terminalSettingsChanged(null, null)).toBe(false);
  });
});

describe("useTerminalSetup", () => {
  it("leaves terminals alone when an unrelated setting changes", async () => {
    renderHook(() => useTerminalSetup());
    // Loading the preferences restyles once; only changes after that matter here.
    await new Promise((r) => setTimeout(r, 0));
    vi.mocked(refreshTerminals).mockClear();
    const s = useSettings.getState().settings!;
    useSettings.setState({ settings: { ...s, sidebarCollapsed: true } });
    useSettings.setState({ settings: { ...s, sidebarCollapsed: true, onboardingDone: true } });
    useSettings.setState({ settings: { ...s, autoLockMinutes: 5 } });
    await new Promise((r) => setTimeout(r, 0));
    expect(refreshTerminals).not.toHaveBeenCalled();
  });

  it("restyles terminals when the theme changes", async () => {
    renderHook(() => useTerminalSetup());
    await new Promise((r) => setTimeout(r, 0));
    vi.mocked(refreshTerminals).mockClear();
    const s = useSettings.getState().settings!;
    useSettings.setState({ settings: { ...s, theme: "sand" } });
    expect(refreshTerminals).toHaveBeenCalledTimes(1);
    useSettings.setState({ settings: { ...s, theme: "sand", systemDarkTheme: "graphite" } });
    expect(refreshTerminals).toHaveBeenCalledTimes(2);
  });

  it("restyles terminals when terminal preferences change", async () => {
    renderHook(() => useTerminalSetup());
    await new Promise((r) => setTimeout(r, 0));
    vi.mocked(refreshTerminals).mockClear();
    useTerminalPrefs.setState({
      prefs: { ...DEFAULT_TERMINAL_PREFS, highlightEnabled: false },
    });
    expect(refreshTerminals).toHaveBeenCalledTimes(1);
  });

  it("stops listening when unmounted", async () => {
    const { unmount } = renderHook(() => useTerminalSetup());
    await new Promise((r) => setTimeout(r, 0));
    unmount();
    vi.mocked(refreshTerminals).mockClear();
    const s = useSettings.getState().settings!;
    useSettings.setState({ settings: { ...s, theme: "paper" } });
    expect(refreshTerminals).not.toHaveBeenCalled();
  });
});
