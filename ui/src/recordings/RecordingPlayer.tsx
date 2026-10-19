import { Terminal } from "@xterm/xterm";
import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent } from "@/components/ui/Dialog";
import { NativeSelect } from "@/components/ui/NativeSelect";
import { Skeleton } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import * as ipc from "@/lib/ipc";
import type { RecordingInfo } from "@/lib/ipc";
import { useNotifications } from "@/stores/notifications";
import { profileById, useTerminalPrefs } from "@/stores/terminalPrefs";
import { paletteFor } from "@/terminal/controller";
import { terminalOptions } from "@/terminal/registry";
import { formatTime, parseCast, type Cast } from "./cast";
import { Replayer } from "./replayer";
import { recordingTitle } from "./title";

const SPEEDS = [0.5, 1, 2, 4, 8] as const;
/** With "shorten pauses", no pause on the timeline is longer than this. */
const MAX_IDLE_SECS = 2;

/** Replays a recording in a read-only terminal. */
export function RecordingPlayer({
  recording,
  onClose,
}: {
  recording: RecordingInfo;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const replayer = useRef<Replayer | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  // Everything the controls show; updated only from the replayer's callback.
  const [view, setView] = useState({ time: 0, playing: false, duration: 0, ready: false });
  const [speed, setSpeed] = useState(1);
  const [shorten, setShorten] = useState(true);
  const notifyError = useNotifications((s) => s.notifyError);

  useEffect(() => {
    let alive = true;
    ipc
      .recordingCast(recording.id)
      .then((text) => alive && setRaw(text))
      .catch((e: unknown) => {
        notifyError(e, "Could not open the recording");
        onClose();
      });
    return () => {
      alive = false;
    };
  }, [recording.id, notifyError, onClose]);

  // Build the terminal and replayer once the cast is loaded.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || raw === null) return;
    let cast: Cast;
    try {
      cast = parseCast(raw, MAX_IDLE_SECS);
    } catch (e) {
      notifyError(e, "Could not play the recording");
      return;
    }
    const profile = profileById(useTerminalPrefs.getState().prefs);
    const term = new Terminal({
      ...terminalOptions(profile, paletteFor(profile)),
      disableStdin: true,
      cursorBlink: false,
      cols: cast.header.width,
      rows: cast.header.height,
    });
    term.open(host);
    const r: Replayer = new Replayer(
      cast,
      {
        write: (d) => term.write(d),
        reset: () => term.reset(),
        resize: (c, rows) => term.resize(Math.max(2, c), Math.max(1, rows)),
      },
      (s) => setView({ ...s, duration: r.duration, ready: true }),
    );
    replayer.current = r;
    r.play();
    return () => {
      r.dispose();
      replayer.current = null;
      term.dispose();
    };
  }, [raw, notifyError]);

  function toggleShorten(on: boolean) {
    setShorten(on);
    if (raw === null || !replayer.current) return;
    replayer.current.setCast(parseCast(raw, on ? MAX_IDLE_SECS : Infinity));
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`${recordingTitle(recording)} · ${recording.protocol.toUpperCase()}`}
        description={new Date(recording.startedAt).toLocaleString()}
        className="flex max-h-[calc(100vh-48px)] w-[min(1100px,calc(100vw-32px))] flex-col"
      >
        <div
          className="min-h-[200px] flex-1 overflow-auto rounded-lg bg-bg p-2"
          onKeyDown={(e) => {
            if (e.key === " ") {
              e.preventDefault();
              replayer.current?.toggle();
            }
          }}
        >
          {raw === null && <Skeleton className="h-80" />}
          <div ref={hostRef} aria-label="Recording" />
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button
            size="sm"
            variant="primary"
            aria-label={view.playing ? "Pause" : "Play"}
            disabled={!view.ready}
            onClick={() => replayer.current?.toggle()}
          >
            {view.playing ? <Pause size={14} /> : <Play size={14} />}
          </Button>
          <span className="w-24 font-mono text-xs text-fg-muted tabular-nums">
            {formatTime(view.time)} / {formatTime(view.duration)}
          </span>
          <input
            type="range"
            aria-label="Position"
            className="flex-1 accent-[var(--accent)]"
            min={0}
            max={Math.max(view.duration, 0.1)}
            step={0.1}
            value={view.time}
            disabled={!view.ready}
            onChange={(e) => replayer.current?.seek(Number(e.target.value))}
          />
          <NativeSelect
            aria-label="Speed"
            className="h-7"
            value={String(speed)}
            onChange={(e) => {
              const s = Number(e.target.value);
              setSpeed(s);
              if (replayer.current) replayer.current.speed = s;
            }}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </NativeSelect>
          <label className="flex items-center gap-2 text-xs text-fg-muted">
            <Switch checked={shorten} onCheckedChange={toggleShorten} aria-label="Shorten pauses" />
            Shorten pauses
          </label>
        </div>
      </DialogContent>
    </Dialog>
  );
}
