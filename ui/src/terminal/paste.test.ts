import { describe, expect, it } from "vitest";
import { isMultiline, pasteLines, slowPasteChunks } from "./paste";

describe("paste helpers", () => {
  it("detects multi-line pastes regardless of line endings", () => {
    expect(isMultiline("show version")).toBe(false);
    expect(isMultiline("show version\n")).toBe(false);
    expect(isMultiline("conf t\r\nint gi1/0/1\r\n")).toBe(true);
    expect(isMultiline("a\rb")).toBe(true);
  });

  it("splits into lines", () => {
    expect(pasteLines("a\r\nb\nc\n")).toEqual(["a", "b", "c"]);
  });

  it("sends each line with CR for slow pastes", () => {
    expect(slowPasteChunks("conf t\nhostname x\n")).toEqual(["conf t\r", "hostname x\r"]);
    expect(slowPasteChunks("conf t\nhostname x")).toEqual(["conf t\r", "hostname x"]);
  });
});
