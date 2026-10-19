import type { DiffRow } from "@/lib/ipc";

/** Lines of context kept around changes when unchanged runs are collapsed. */
const CONTEXT = 3;

export type Block =
  { kind: "rows"; rows: DiffRow[] } | { kind: "fold"; rows: DiffRow[]; id: number };

/** Split rows into visible runs and folds of unchanged lines far from any change. */
export function foldRows(rows: readonly DiffRow[]): Block[] {
  const changed = rows.map((r) => r.kind !== "same");
  const near = rows.map((_, i) => {
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(rows.length - 1, i + CONTEXT); k++)
      if (changed[k]) return true;
    return false;
  });
  const out: Block[] = [];
  let i = 0;
  let id = 0;
  while (i < rows.length) {
    const start = i;
    const fold = !near[i];
    while (i < rows.length && !near[i] === fold) i++;
    const slice = rows.slice(start, i);
    // Folding fewer than 4 lines saves nothing.
    if (fold && slice.length >= 4) out.push({ kind: "fold", rows: slice, id: id++ });
    else out.push({ kind: "rows", rows: slice });
  }
  return out;
}
