import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE } from "@/stores/terminalPrefs";
import { validateProfile } from "./validateProfile";

describe("validateProfile", () => {
  it("accepts the default profile", () => {
    expect(validateProfile(DEFAULT_PROFILE)).toBeNull();
  });

  it.each([
    [{ name: " " }, /name/],
    [{ fontSize: 2 }, /Font size/],
    [{ lineHeight: 3 }, /Line height/],
    [{ scrollback: 10 }, /Scrollback/],
    [{ opacity: 0.2 }, /Opacity/],
    [{ pasteLineDelayMs: 9000 }, /Paste delay/],
  ])("rejects %o", (patch, message) => {
    expect(validateProfile({ ...DEFAULT_PROFILE, ...patch })).toMatch(message);
  });
});
