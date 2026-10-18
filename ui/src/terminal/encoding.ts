const encoder = new TextEncoder();

/** xterm `onData` strings are UTF-16; the backend wants UTF-8 bytes. */
export function encodeInput(data: string): Uint8Array {
  return encoder.encode(data);
}

/** xterm `onBinary` strings carry one byte per char (mouse reports in X10 mode). */
export function encodeBinary(data: string): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data.charCodeAt(i) & 0xff;
  return out;
}
