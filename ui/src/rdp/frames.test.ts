import { describe, expect, it } from "vitest";
import { parseRdpBinary, TAG_FRAME, TAG_POINTER } from "./frames";

function le(...values: number[]): number[] {
  return values.flatMap((v) => [v & 0xff, v >> 8]);
}

describe("RDP binary messages", () => {
  it("parses a frame with its rectangles", () => {
    const bytes = Uint8Array.from([
      TAG_FRAME,
      ...le(4, 2, 1),
      ...le(1, 0, 2, 1),
      ...[1, 2, 3, 255, 4, 5, 6, 255],
    ]);
    const msg = parseRdpBinary(bytes);
    expect(msg?.kind).toBe("frame");
    if (msg?.kind !== "frame") return;
    expect([msg.width, msg.height]).toEqual([4, 2]);
    expect(msg.rects).toHaveLength(1);
    expect(msg.rects[0]).toMatchObject({ x: 1, y: 0, w: 2, h: 1 });
    expect(Array.from(msg.rects[0]!.pixels)).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });

  it("parses a pointer with its hotspot", () => {
    const bytes = Uint8Array.from([TAG_POINTER, ...le(1, 1, 0, 0), 9, 9, 9, 128]);
    expect(parseRdpBinary(bytes)).toMatchObject({ kind: "pointer", width: 1, hotX: 0 });
  });

  it("rejects truncated, out-of-bounds and unknown messages", () => {
    expect(parseRdpBinary(Uint8Array.from([TAG_FRAME, ...le(4, 2, 1), ...le(0, 0, 1, 1)]))).toBe(
      null,
    );
    const outside = Uint8Array.from([TAG_FRAME, ...le(1, 1, 1), ...le(1, 0, 1, 1), 0, 0, 0, 0]);
    expect(parseRdpBinary(outside)).toBe(null);
    expect(parseRdpBinary(Uint8Array.from([7]))).toBe(null);
    expect(parseRdpBinary(new Uint8Array())).toBe(null);
  });
});
