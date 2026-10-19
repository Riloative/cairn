import { describe, expect, it } from "vitest";
import { parseCast } from "./cast";
import { Replayer, type ReplayState } from "./replayer";

const file = [
  JSON.stringify({ version: 2, width: 80, height: 24 }),
  JSON.stringify([1, "o", "a"]),
  JSON.stringify([2, "o", "b"]),
  JSON.stringify([3, "r", "100x30"]),
  JSON.stringify([4, "o", "c"]),
].join("\n");

function setup() {
  const log: string[] = [];
  const screen = {
    write: (d: string) => log.push(`w:${d}`),
    reset: () => log.push("reset"),
    resize: (c: number, r: number) => log.push(`size:${c}x${r}`),
  };
  let now = 0;
  const frames: ((n: number) => void)[] = [];
  const clock = {
    now: () => now,
    request: (cb: (n: number) => void) => frames.push(cb),
    cancel: () => {},
  };
  const states: ReplayState[] = [];
  const r = new Replayer(parseCast(file), screen, (s) => states.push(s), clock);
  /** Advance the clock and run the pending frame. */
  const step = (ms: number) => {
    now += ms;
    frames.shift()?.(now);
  };
  return { r, log, states, step };
}

describe("replayer", () => {
  it("plays in real time, honours speed and stops at the end", () => {
    const { r, log, states, step } = setup();
    expect(log).toEqual(["reset", "size:80x24"]);
    r.play();
    step(1500);
    expect(log.slice(2)).toEqual(["w:a"]);
    r.speed = 2;
    step(1000); // +2 s at 2x → 3.5 s
    expect(log.slice(3)).toEqual(["w:b", "size:100x30"]);
    step(1000);
    expect(log.at(-1)).toBe("w:c");
    expect(states.at(-1)).toEqual({ time: 4, playing: false });
  });

  it("seeks forward by writing in one batch and backward by replaying", () => {
    const { r, log } = setup();
    r.seek(2.5);
    expect(log.slice(2)).toEqual(["w:ab"]);
    r.seek(1);
    expect(log.slice(3)).toEqual(["reset", "size:80x24", "w:a"]);
    r.seek(99);
    expect(log.slice(6)).toEqual(["w:b", "size:100x30", "w:c"]);
  });

  it("restarts when played again from the end", () => {
    const { r, log } = setup();
    r.seek(4);
    r.play();
    expect(log.slice(-2)).toEqual(["reset", "size:80x24"]);
  });
});
