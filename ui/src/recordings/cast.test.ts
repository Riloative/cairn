import { describe, expect, it } from "vitest";
import { formatTime, indexAt, parseCast } from "./cast";

const header = JSON.stringify({ version: 2, width: 80, height: 24 });
const file = [
  header,
  JSON.stringify([0.5, "o", "sw1# "]),
  JSON.stringify([1.0, "i", "show ver\r"]),
  JSON.stringify([1.5, "r", "120x40"]),
  "not json",
  JSON.stringify([100.0, "o", "Cisco IOS\r\n"]),
  JSON.stringify([101.0, "o", "sw1# "]),
].join("\n");

describe("asciicast", () => {
  it("parses output and resize events and skips the rest", () => {
    const cast = parseCast(file);
    expect(cast.header.width).toBe(80);
    expect(cast.events.map((e) => e.kind)).toEqual(["o", "r", "o", "o"]);
    expect(cast.events[1]).toEqual({ t: 1.5, kind: "r", cols: 120, rows: 40 });
    expect(cast.duration).toBe(101);
  });

  it("compresses long pauses", () => {
    const cast = parseCast(file, 2);
    // 1.5 → 100 is shortened to 2 seconds.
    expect(cast.events.map((e) => e.t)).toEqual([0.5, 1.5, 3.5, 4.5]);
    expect(cast.duration).toBe(4.5);
  });

  it("finds the events shown by a point in time", () => {
    const cast = parseCast(file, 2);
    expect(indexAt(cast, 0)).toBe(0);
    expect(indexAt(cast, 0.5)).toBe(1);
    expect(indexAt(cast, 3)).toBe(2);
    expect(indexAt(cast, 99)).toBe(4);
  });

  it("rejects other formats", () => {
    expect(() => parseCast(JSON.stringify({ version: 1 }))).toThrow(/v2/);
    expect(() => parseCast("")).toThrow(/empty/);
  });

  it("formats times", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(65.9)).toBe("1:05");
    expect(formatTime(3725)).toBe("1:02:05");
  });
});
