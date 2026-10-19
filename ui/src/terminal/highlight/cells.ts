import type { IBufferLine } from "@xterm/xterm";

/**
 * Text of a buffer line plus a map from UTF-16 offsets to cell columns. Wide characters
 * (CJK, emoji) take two cells; surrogate pairs take two code units.
 */
export interface LineText {
  text: string;
  /** colOf[i] = cell column of text[i]; colOf[text.length] = end column. */
  colOf: number[];
}

/** Minimal cell accessor so the mapping is testable without a terminal. */
export interface CellLike {
  getChars(): string;
  getWidth(): number;
}

export function lineText(cells: (x: number) => CellLike | undefined, cols: number): LineText {
  let text = "";
  const colOf: number[] = [];
  for (let x = 0; x < cols; x++) {
    const cell = cells(x);
    if (!cell) break;
    const width = cell.getWidth();
    if (width === 0) continue; // trailing half of a wide character
    const chars = cell.getChars() || " ";
    for (let i = 0; i < chars.length; i++) colOf.push(x);
    text += chars;
  }
  colOf.push(cols);
  // Trim trailing blanks so line comparisons are stable.
  let end = text.length;
  while (end > 0 && text[end - 1] === " ") end--;
  return { text: text.slice(0, end), colOf: colOf.slice(0, end).concat(colOf[end] ?? cols) };
}

export function bufferLineText(line: IBufferLine, cols: number): LineText {
  return lineText((x) => line.getCell(x), cols);
}

/** Cell range [x, x + width) for a text range. */
export function cellRange(map: LineText, start: number, end: number): { x: number; width: number } {
  const x = map.colOf[start] ?? 0;
  const last = map.colOf[Math.min(end, map.colOf.length - 1)] ?? x + (end - start);
  return { x, width: Math.max(1, last - x) };
}
