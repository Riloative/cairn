/** Normalise pasted text to lines (CRLF/CR → LF; a single trailing newline is dropped). */
export function pasteLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return trimmed.split("\n");
}

/** Whether a paste needs confirmation: more than one line. */
export function isMultiline(text: string): boolean {
  return pasteLines(text).length > 1;
}

/** Bytes to send for one line of a slow (per-line delayed) paste. */
export function slowPasteChunks(text: string): string[] {
  const lines = pasteLines(text);
  const endsWithNewline = /\r?\n$|\r$/.test(text);
  return lines.map((l, i) => (i < lines.length - 1 || endsWithNewline ? `${l}\r` : l));
}
