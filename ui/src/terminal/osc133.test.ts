import { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { formatDuration, parseOsc133, trackCommands } from "./osc133";

describe("OSC 133", () => {
  it("parses marks", () => {
    expect(parseOsc133("A")).toEqual({ kind: "A" });
    expect(parseOsc133("C")).toEqual({ kind: "C" });
    expect(parseOsc133("D;2")).toEqual({ kind: "D", exitCode: 2 });
    expect(parseOsc133("D")).toEqual({ kind: "D", exitCode: null });
    expect(parseOsc133("P;k=i")).toBeNull();
  });

  it("formats durations", () => {
    expect(formatDuration(9_400)).toBe("9s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(3_720_000)).toBe("1h 2m");
  });

  it("reports finished commands from the stream", async () => {
    const term = new Terminal({ allowProposedApi: true });
    let t = 1000;
    const done = vi.fn();
    trackCommands(term, done, () => t);
    await new Promise<void>((r) =>
      term.write("\x1b]133;A\x07$ \x1b]133;B\x07sleep\r\n\x1b]133;C\x07", r),
    );
    t = 16_000;
    await new Promise<void>((r) => term.write("\x1b]133;D;0\x07", r));
    expect(done).toHaveBeenCalledWith(15_000, 0);
    term.dispose();
  });
});
