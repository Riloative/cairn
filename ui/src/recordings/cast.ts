/**
 * asciicast v2 parsing and the replay timeline. Pauses longer than `maxIdle` are
 * shortened on the timeline (like `asciinema play -i`), so a recording that sat idle
 * for an hour still plays through in reasonable time.
 */

export interface CastHeader {
  version: number;
  width: number;
  height: number;
  timestamp?: number;
  title?: string;
}

export type CastEvent =
  { t: number; kind: "o"; data: string } | { t: number; kind: "r"; cols: number; rows: number };

export interface Cast {
  header: CastHeader;
  /** Events in order, with `t` on the (idle-compressed) timeline in seconds. */
  events: CastEvent[];
  duration: number;
}

/** Parse a cast file; unknown event types (input, markers) are skipped. */
export function parseCast(text: string, maxIdle = Infinity): Cast {
  const lines = text.split("\n").filter((l) => l.trim());
  const first = lines.shift();
  if (!first) throw new Error("The recording is empty.");
  const header = JSON.parse(first) as CastHeader;
  if (header.version !== 2) throw new Error("Only asciicast v2 recordings can be played.");
  const events: CastEvent[] = [];
  let last = 0;
  let shift = 0;
  for (const line of lines) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(raw) || raw.length < 3) continue;
    const [time, code, data] = raw as [unknown, unknown, unknown];
    if (typeof time !== "number" || typeof data !== "string") continue;
    // Compress long pauses: the timeline moves by at most `maxIdle` between events.
    const gap = time - last;
    if (gap > maxIdle) shift += gap - maxIdle;
    last = time;
    const t = Math.max(0, time - shift);
    if (code === "o") events.push({ t, kind: "o", data });
    else if (code === "r") {
      const m = /^(\d+)x(\d+)$/.exec(data);
      if (m) events.push({ t, kind: "r", cols: Number(m[1]), rows: Number(m[2]) });
    }
  }
  return { header, events, duration: events.at(-1)?.t ?? 0 };
}

/** Index of the first event after time `t` (events before it have been shown). */
export function indexAt(cast: Cast, t: number): number {
  let lo = 0;
  let hi = cast.events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((cast.events[mid]?.t ?? Infinity) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** `m:ss` or `h:mm:ss`. */
export function formatTime(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
