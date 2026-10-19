import { describe, expect, it } from "vitest";
import { formatShortcut, matchesShortcut } from "./shortcuts";

function key(init: KeyboardEventInit) {
  return new KeyboardEvent("keydown", init);
}

describe("shortcuts", () => {
  it("maps Mod to Cmd on macOS and Ctrl elsewhere", () => {
    expect(matchesShortcut("Mod+K", key({ key: "k", metaKey: true }), true)).toBe(true);
    expect(matchesShortcut("Mod+K", key({ key: "k", ctrlKey: true }), true)).toBe(false);
    expect(matchesShortcut("Mod+K", key({ key: "k", ctrlKey: true }), false)).toBe(true);
    expect(matchesShortcut("Mod+K", key({ key: "k", metaKey: true }), false)).toBe(false);
  });

  it("requires exact modifiers", () => {
    expect(matchesShortcut("Mod+K", key({ key: "K", ctrlKey: true, shiftKey: true }), false)).toBe(
      false,
    );
    expect(
      matchesShortcut("Mod+Shift+L", key({ key: "L", ctrlKey: true, shiftKey: true }), false),
    ).toBe(true);
  });

  it("matches digits by physical key", () => {
    expect(matchesShortcut("Mod+1", key({ key: "!", code: "Digit1", metaKey: true }), true)).toBe(
      true,
    );
  });

  it("formats for each platform", () => {
    expect(formatShortcut("Mod+Shift+L", true)).toEqual(["⌘", "⇧", "L"]);
    expect(formatShortcut("Mod+Shift+L", false)).toEqual(["Ctrl", "Shift", "L"]);
    expect(formatShortcut("Ctrl+Tab", false)).toEqual(["Ctrl", "Tab"]);
  });
});
