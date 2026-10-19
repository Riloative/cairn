/**
 * Decoding of the binary messages an RDP session sends (format in
 * `crates/proto-rdp/src/frame.rs`): tag 0 = frame of dirty rectangles, tag 1 = cursor.
 */

export const TAG_FRAME = 0;
export const TAG_POINTER = 1;

export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** RGBA pixels, a view into the message (no copy). */
  pixels: Uint8ClampedArray<ArrayBuffer>;
}

export type RdpBinary =
  | { kind: "frame"; width: number; height: number; rects: FrameRect[] }
  | {
      kind: "pointer";
      width: number;
      height: number;
      hotX: number;
      hotY: number;
      pixels: Uint8ClampedArray<ArrayBuffer>;
    };

/** Parse one message; `null` for a malformed or unknown one. */
export function parseRdpBinary(bytes: Uint8Array): RdpBinary | null {
  // Channel payloads are plain ArrayBuffers, never shared memory.
  const buffer = bytes.buffer as ArrayBuffer;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  if (bytes.length < 1) return null;
  if (bytes[0] === TAG_FRAME) {
    if (bytes.length < 7) return null;
    const width = u16(1);
    const height = u16(3);
    const count = u16(5);
    const rects: FrameRect[] = [];
    let at = 7;
    for (let i = 0; i < count; i++) {
      if (at + 8 > bytes.length) return null;
      const x = u16(at);
      const y = u16(at + 2);
      const w = u16(at + 4);
      const h = u16(at + 6);
      at += 8;
      const len = w * h * 4;
      if (at + len > bytes.length || x + w > width || y + h > height) return null;
      rects.push({
        x,
        y,
        w,
        h,
        pixels: new Uint8ClampedArray(buffer, bytes.byteOffset + at, len),
      });
      at += len;
    }
    return { kind: "frame", width, height, rects };
  }
  if (bytes[0] === TAG_POINTER) {
    if (bytes.length < 9) return null;
    const width = u16(1);
    const height = u16(3);
    const len = width * height * 4;
    if (bytes.length < 9 + len) return null;
    return {
      kind: "pointer",
      width,
      height,
      hotX: u16(5),
      hotY: u16(7),
      pixels: new Uint8ClampedArray(buffer, bytes.byteOffset + 9, len),
    };
  }
  return null;
}
