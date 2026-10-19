import { save } from "@tauri-apps/plugin-dialog";
import { Clapperboard, MoreHorizontal, Play, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/Menu";
import { Skeleton } from "@/components/ui/Skeleton";
import * as ipc from "@/lib/ipc";
import type { RecordingInfo } from "@/lib/ipc";
import { confirmAction } from "@/stores/confirm";
import { useNotifications } from "@/stores/notifications";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { dateFormat } from "@/views/auditFormat";
import { formatTime } from "./cast";
import { RecordingPlayer } from "./RecordingPlayer";
import { recordingTitle } from "./title";

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const slug = (s: string) => s.replace(/[^\w.-]+/g, "_").slice(0, 60) || "session";

/** Recorded terminal sessions: replay, export (.cast / text), delete. */
export function RecordingsList() {
  const [list, setList] = useState<RecordingInfo[] | null>(null);
  const [version, setVersion] = useState(0);
  const [query, setQuery] = useState("");
  const [playing, setPlaying] = useState<RecordingInfo | null>(null);
  const recordAll = useSettings((s) => s.settings?.recordSessions ?? false);
  const notifyError = useNotifications((s) => s.notifyError);
  const notify = useNotifications((s) => s.notify);

  useEffect(() => {
    let alive = true;
    ipc
      .recordingsList()
      .then((l) => alive && setList(l))
      .catch((e: unknown) => notifyError(e, "Could not load the recordings"));
    return () => {
      alive = false;
    };
  }, [version, notifyError]);

  async function exportAs(r: RecordingInfo, format: "cast" | "text") {
    const ext = format === "cast" ? "cast" : "txt";
    const path = await save({
      title: format === "cast" ? "Export recording" : "Export transcript",
      defaultPath: `${slug(recordingTitle(r))}-${r.startedAt.slice(0, 10)}.${ext}`,
      filters: [{ name: format === "cast" ? "asciicast" : "Text", extensions: [ext] }],
    });
    if (!path) return;
    try {
      await ipc.recordingExport(r.id, format, path);
      notify({ variant: "success", title: "Recording exported", description: path });
    } catch (e) {
      notifyError(e, "Could not export the recording");
    }
  }

  async function remove(r: RecordingInfo) {
    const ok = await confirmAction({
      title: `Delete the recording of ${recordingTitle(r)}?`,
      description: `${dateFormat.format(new Date(r.startedAt))}. The deletion is recorded in the audit log.`,
      confirmLabel: "Delete recording",
      destructive: true,
    });
    if (!ok) return;
    try {
      await ipc.recordingDelete(r.id);
      setVersion((v) => v + 1);
    } catch (e) {
      notifyError(e, "Could not delete the recording");
    }
  }

  if (list === null) {
    return (
      <div className="flex flex-col gap-2 p-6">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-8" />
        ))}
      </div>
    );
  }
  if (list.length === 0) {
    return (
      <EmptyState
        icon={<Clapperboard size={20} />}
        title="No recordings yet"
        description={
          recordAll
            ? "Every terminal session is recorded. Recordings appear here when a session starts."
            : "Turn on recording for all sessions in Settings → Security, or for single devices in their connection settings."
        }
        action={
          recordAll
            ? undefined
            : { label: "Open settings", onClick: () => useUi.getState().setView("settings") }
        }
      />
    );
  }

  const q = query.trim().toLowerCase();
  const shown = q
    ? list.filter((r) => [r.device, r.target, r.protocol].some((v) => v.toLowerCase().includes(q)))
    : list;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 pb-2">
        <div className="relative w-56">
          <Search
            size={13}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-subtle"
          />
          <Input
            aria-label="Search recordings"
            placeholder="Device or address"
            className="h-7 pl-7"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <span className="flex-1" />
        <span className="text-xs text-fg-subtle" role="status">
          {shown.length} {shown.length === 1 ? "recording" : "recordings"}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead className="sticky top-0 bg-surface text-left text-xs text-fg-subtle">
            <tr>
              <th className="w-56 px-2 py-2 font-medium">Started</th>
              <th className="px-2 py-2 font-medium">Device</th>
              <th className="w-24 px-2 py-2 font-medium">Protocol</th>
              <th className="w-24 px-2 py-2 font-medium">Length</th>
              <th className="w-24 px-2 py-2 font-medium">Size</th>
              <th className="w-24" aria-hidden />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="group hover:bg-surface-raised">
                <td className="px-2 py-1.5 text-fg-muted">
                  {dateFormat.format(new Date(r.startedAt))}
                </td>
                <td className="max-w-0 truncate px-2 py-1.5">
                  {recordingTitle(r)}
                  {r.device && <span className="ml-2 text-xs text-fg-subtle">{r.target}</span>}
                </td>
                <td className="px-2 py-1.5 text-fg-muted uppercase">{r.protocol}</td>
                <td className="px-2 py-1.5 font-mono text-xs text-fg-muted">
                  {r.endedAt ? formatTime(r.durationMs / 1000) : "recording…"}
                </td>
                <td className="px-2 py-1.5 text-xs text-fg-muted">
                  {size(r.bytes)}
                  {r.truncated && (
                    <span
                      className="ml-1 text-warning"
                      title="Output beyond the size limit was not recorded"
                    >
                      (cut)
                    </span>
                  )}
                </td>
                <td className="px-2 py-1 text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Play recording of ${recordingTitle(r)}`}
                    onClick={() => setPlaying(r)}
                  >
                    <Play size={13} /> Play
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`More actions for ${recordingTitle(r)}`}
                      >
                        <MoreHorizontal size={13} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => void exportAs(r, "cast")}>
                        Export as asciicast (.cast)
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void exportAs(r, "text")}>
                        Export transcript (.txt)
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem destructive onSelect={() => void remove(r)}>
                        Delete recording…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {playing && <RecordingPlayer recording={playing} onClose={() => setPlaying(null)} />}
    </div>
  );
}
