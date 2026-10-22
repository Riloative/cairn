import { FileDiff, FileText, ScrollText, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import * as ipc from "@/lib/ipc";
import type { Device, SnapshotInfo } from "@/lib/ipc";
import { confirmAction } from "@/stores/confirm";
import { useNotifications } from "@/stores/notifications";
import { ConfigViewer, type ViewerTarget } from "./ConfigViewer";
import { grabConfig, useGrab } from "./grab";

const when = (iso: string) => new Date(iso).toLocaleString();

/** A device's configuration snapshots: grab, view, compare, export, delete. */
export function ConfigHistory({ device }: { device: Device }) {
  const [list, setList] = useState<SnapshotInfo[] | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);
  const running = useGrab((s) => s.running.includes(device.id));
  const version = useGrab((s) => s.version);

  const load = useCallback(() => {
    ipc
      .configSnapshots(device.id)
      .then(setList, (e: unknown) =>
        useNotifications.getState().notifyError(e, "Could not load the configuration history"),
      );
  }, [device.id]);

  useEffect(load, [load, version]);

  const toggle = (id: number) =>
    setPicked(picked.includes(id) ? picked.filter((p) => p !== id) : [...picked.slice(-1), id]);

  function compare() {
    if (!list) return;
    // Two picked snapshots, else the newest against the one before it.
    const chosen =
      picked.length === 2 ? list.filter((s) => picked.includes(s.id)) : list.slice(0, 2);
    const [newer, older] = [...chosen].sort(
      (a, b) => b.takenAt.localeCompare(a.takenAt) || b.id - a.id,
    );
    if (newer && older) setViewer({ kind: "diff", host: device.hostname, older, newer });
  }

  async function remove(s: SnapshotInfo) {
    const ok = await confirmAction({
      title: "Delete this snapshot?",
      description: `The configuration of ${device.hostname} from ${when(s.takenAt)} is removed.`,
      confirmLabel: "Delete snapshot",
      destructive: true,
    });
    if (!ok) return;
    try {
      await ipc.configSnapshotDelete(s.id);
      setPicked(picked.filter((p) => p !== s.id));
      load();
    } catch (e) {
      useNotifications.getState().notifyError(e, "Could not delete the snapshot");
    }
  }

  const canCompare = (list?.length ?? 0) >= 2 && (picked.length === 0 || picked.length === 2);

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={running}
          onClick={() => void grabConfig(device)}
        >
          {running ? <Skeleton className="size-3.5 rounded-full" /> : <ScrollText size={13} />}
          {running ? "Grabbing…" : "Grab config"}
        </Button>
        <Button size="sm" variant="secondary" disabled={!canCompare} onClick={compare}>
          <FileDiff size={13} /> {picked.length === 2 ? "Compare selected" : "Compare latest"}
        </Button>
      </div>
      <p className="text-xs text-fg-muted">
        Runs the vendor's show command over SSH with paging turned off. Select two snapshots to
        compare them.
      </p>
      {list === null ? (
        Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-10" />)
      ) : list.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-fg-subtle">
          No snapshots yet.
        </p>
      ) : (
        <ul aria-label="Snapshots" className="flex flex-col">
          {list.map((s, i) => {
            const prev = list[i + 1];
            const changed = !prev || prev.sha256 !== s.sha256;
            return (
              <li
                key={s.id}
                className={cn(
                  "flex items-center gap-2 border-t border-border py-2 text-[13px] first:border-0",
                  picked.includes(s.id) && "bg-accent-subtle",
                )}
              >
                <input
                  type="checkbox"
                  aria-label={`Select snapshot from ${when(s.takenAt)}`}
                  className="ml-1 accent-[var(--accent)]"
                  checked={picked.includes(s.id)}
                  onChange={() => toggle(s.id)}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate">{when(s.takenAt)}</p>
                  <p className="text-xs text-fg-muted">
                    {s.lines} lines · {formatBytes(s.bytes)}
                    {prev && (changed ? " · changed" : " · unchanged")}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`View snapshot from ${when(s.takenAt)}`}
                  onClick={() =>
                    setViewer({ kind: "snapshot", host: device.hostname, snapshot: s })
                  }
                >
                  <FileText size={13} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Delete snapshot from ${when(s.takenAt)}`}
                  onClick={() => void remove(s)}
                >
                  <Trash2 size={13} />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <ConfigViewer target={viewer} onClose={() => setViewer(null)} />
    </div>
  );
}
