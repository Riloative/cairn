import { save } from "@tauri-apps/plugin-dialog";
import { Download } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent } from "@/components/ui/Dialog";
import { Skeleton } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/cn";
import * as ipc from "@/lib/ipc";
import type { ConfigDiff, DiffRow, SnapshotInfo } from "@/lib/ipc";
import { useNotifications } from "@/stores/notifications";
import { foldRows } from "./fold";
import { highlightLine } from "./highlight";

export type ViewerTarget =
  | { kind: "snapshot"; host: string; snapshot: SnapshotInfo }
  | { kind: "diff"; host: string; older: SnapshotInfo; newer: SnapshotInfo };

const when = (iso: string) => new Date(iso).toLocaleString();

const CELL: Record<DiffRow["kind"], [string, string]> = {
  same: ["", ""],
  removed: ["bg-danger/10", "bg-surface-raised/40"],
  added: ["bg-surface-raised/40", "bg-success/10"],
  changed: ["bg-danger/10", "bg-success/10"],
};

function Row({ row }: { row: DiffRow }) {
  const [l, r] = CELL[row.kind];
  return (
    <tr className="align-top">
      <td className="w-12 pr-2 text-right text-fg-subtle select-none">{row.left?.n}</td>
      <td className={cn("w-1/2 px-2 whitespace-pre-wrap break-all", l)}>
        {row.left && highlightLine(row.left.text)}
      </td>
      <td className="w-12 border-l border-border pr-2 text-right text-fg-subtle select-none">
        {row.right?.n}
      </td>
      <td className={cn("w-1/2 px-2 whitespace-pre-wrap break-all", r)}>
        {row.right && highlightLine(row.right.text)}
      </td>
    </tr>
  );
}

function DiffTable({ diff, changesOnly }: { diff: ConfigDiff; changesOnly: boolean }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const blocks = useMemo(
    () => (changesOnly ? foldRows(diff.rows) : [{ kind: "rows" as const, rows: diff.rows }]),
    [diff, changesOnly],
  );
  return (
    <table className="w-full table-fixed font-mono text-xs leading-5" data-selectable>
      <tbody>
        {blocks.map((b, i) =>
          b.kind === "rows" || open.has(b.id) ? (
            <Fragment key={i}>
              {b.rows.map((r, k) => (
                <Row key={k} row={r} />
              ))}
            </Fragment>
          ) : (
            <tr key={i}>
              <td colSpan={4} className="py-0.5">
                <button
                  type="button"
                  onClick={() => setOpen(new Set(open).add(b.id))}
                  className="w-full rounded bg-surface-raised py-0.5 text-center font-sans text-xs text-fg-muted hover:text-fg"
                >
                  ⋯ {b.rows.length} unchanged lines
                </button>
              </td>
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

function Body({ target }: { target: ViewerTarget }) {
  const [diff, setDiff] = useState<ConfigDiff | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [changesOnly, setChangesOnly] = useState(true);

  useEffect(() => {
    const fail = (e: unknown) =>
      useNotifications.getState().notifyError(e, "Could not open the configuration");
    if (target.kind === "diff")
      ipc.configDiff(target.older.id, target.newer.id).then(setDiff, fail);
    else ipc.configSnapshot(target.snapshot.id).then((s) => setContent(s.content), fail);
  }, [target]);

  async function exportFile() {
    const stamp = (target.kind === "diff" ? target.newer : target.snapshot).takenAt.slice(0, 10);
    const path = await save({
      title: "Export",
      defaultPath: `${target.host}-${stamp}.${target.kind === "diff" ? "diff" : "txt"}`,
    });
    if (!path) return;
    try {
      const written =
        target.kind === "diff"
          ? await ipc.configExport(target.newer.id, target.older.id, path)
          : await ipc.configExport(target.snapshot.id, null, path);
      useNotifications
        .getState()
        .notify({ variant: "success", title: "Exported", description: written });
    } catch (e) {
      useNotifications.getState().notifyError(e, "Could not export");
    }
  }

  const loading = target.kind === "diff" ? !diff : content === null;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-3 text-xs">
        {target.kind === "diff" && diff && (
          <>
            <span className="text-success">+{diff.added}</span>
            <span className="text-danger">−{diff.removed}</span>
            {diff.added + diff.removed === 0 && (
              <span className="text-fg-muted">No differences.</span>
            )}
            <label className="ml-2 flex items-center gap-2 text-fg-muted">
              <Switch
                checked={changesOnly}
                onCheckedChange={setChangesOnly}
                aria-label="Changes only"
              />
              Changes only
            </label>
          </>
        )}
        <span className="flex-1" />
        <Button size="sm" variant="secondary" disabled={loading} onClick={() => void exportFile()}>
          <Download size={13} /> {target.kind === "diff" ? "Export diff…" : "Export…"}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
        {loading && (
          <div className="flex flex-col gap-1 p-3" aria-busy>
            {Array.from({ length: 12 }, (_, i) => (
              <Skeleton key={i} className="h-4" />
            ))}
          </div>
        )}
        {diff && target.kind === "diff" && (
          <>
            <div className="sticky top-0 grid grid-cols-2 border-b border-border bg-surface text-xs font-medium text-fg-muted">
              <span className="px-3 py-1.5">{when(target.older.takenAt)}</span>
              <span className="border-l border-border px-3 py-1.5">
                {when(target.newer.takenAt)}
              </span>
            </div>
            <DiffTable diff={diff} changesOnly={changesOnly} />
          </>
        )}
        {content !== null && (
          <pre className="p-3 font-mono text-xs leading-5 whitespace-pre-wrap" data-selectable>
            {content.split("\n").map((l, i) => (
              <Fragment key={i}>
                {highlightLine(l)}
                {"\n"}
              </Fragment>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}

/** Full-size viewer for one snapshot or a side-by-side diff of two. */
export function ConfigViewer({
  target,
  onClose,
}: {
  target: ViewerTarget | null;
  onClose: () => void;
}) {
  if (!target) return null;
  const title =
    target.kind === "diff"
      ? `${target.host}: changes`
      : `${target.host}: ${when(target.snapshot.takenAt)}`;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={title}
        description={
          target.kind === "diff"
            ? `${when(target.older.takenAt)} → ${when(target.newer.takenAt)}`
            : target.snapshot.command
        }
        className="flex h-[85vh] w-[min(1200px,calc(100vw-32px))] flex-col [&>div:last-of-type]:flex [&>div:last-of-type]:min-h-0 [&>div:last-of-type]:flex-1"
      >
        <Body target={target} />
      </DialogContent>
    </Dialog>
  );
}
