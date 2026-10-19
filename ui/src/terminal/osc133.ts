import type { Terminal } from "@xterm/xterm";

/**
 * OSC 133 (FinalTerm / shell integration) marks: A = prompt start, B = command start,
 * C = command output start, D[;exit] = command finished. Shells emit these when shell
 * integration is enabled (fish, zsh/bash with integration scripts, VS Code, Ptyxis).
 */
export type Osc133 = { kind: "A" | "B" | "C" } | { kind: "D"; exitCode: number | null };

export function parseOsc133(data: string): Osc133 | null {
  const [mark, ...rest] = data.split(";");
  if (mark === "A" || mark === "B" || mark === "C") return { kind: mark };
  if (mark === "D") {
    const code = rest[0] !== undefined && /^-?\d+$/.test(rest[0]) ? Number(rest[0]) : null;
    return { kind: "D", exitCode: code };
  }
  return null;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Call `onFinished` when a command finishes; never consumes the sequence. */
export function trackCommands(
  term: Terminal,
  onFinished: (durationMs: number, exitCode: number | null) => void,
  now: () => number = Date.now,
): () => void {
  let started: number | null = null;
  const handler = term.parser.registerOscHandler(133, (data) => {
    const mark = parseOsc133(data);
    if (mark?.kind === "C") started = now();
    else if (mark?.kind === "D" && started !== null) {
      onFinished(now() - started, mark.exitCode);
      started = null;
    } else if (mark?.kind === "A") started = null;
    return false;
  });
  return () => handler.dispose();
}
