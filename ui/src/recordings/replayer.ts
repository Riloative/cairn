import { indexAt, type Cast } from "./cast";

/** What the replayer draws on (an xterm instance in the app, a fake in tests). */
export interface Screen {
  write: (data: string) => void;
  reset: () => void;
  resize: (cols: number, rows: number) => void;
}

export interface ReplayState {
  time: number;
  playing: boolean;
}

/**
 * Plays a cast onto a screen: play/pause, speed, and seeking. Seeking backwards
 * resets the screen and replays everything up to the new time (terminal state cannot
 * be rewound), which is fast because nothing waits.
 */
export class Replayer {
  private index = 0;
  private time = 0;
  private playing = false;
  private lastTick = 0;
  private frame: number | null = null;
  speed = 1;

  constructor(
    private cast: Cast,
    private readonly screen: Screen,
    private readonly onChange: (s: ReplayState) => void,
    private readonly clock: {
      now: () => number;
      request: (cb: (now: number) => void) => number;
      cancel: (id: number) => void;
    } = {
      now: () => performance.now(),
      request: (cb) => requestAnimationFrame(cb),
      cancel: (id) => cancelAnimationFrame(id),
    },
  ) {
    this.restart();
  }

  get duration(): number {
    return this.cast.duration;
  }

  private restart() {
    this.screen.reset();
    this.screen.resize(this.cast.header.width, this.cast.header.height);
    this.index = 0;
    this.time = 0;
  }

  /** Apply all events up to time `t`, writing consecutive output in one go. */
  private advance(t: number) {
    let pending = "";
    const end = indexAt(this.cast, t);
    for (; this.index < end; this.index++) {
      const e = this.cast.events[this.index];
      if (!e) break;
      if (e.kind === "o") pending += e.data;
      else {
        if (pending) this.screen.write(pending);
        pending = "";
        this.screen.resize(e.cols, e.rows);
      }
    }
    if (pending) this.screen.write(pending);
    this.time = Math.min(t, this.cast.duration);
  }

  private emit() {
    this.onChange({ time: this.time, playing: this.playing });
  }

  private loop = (now: number) => {
    const dt = ((now - this.lastTick) / 1000) * this.speed;
    this.lastTick = now;
    this.advance(this.time + dt);
    if (this.time >= this.cast.duration) {
      this.playing = false;
      this.frame = null;
    } else {
      this.frame = this.clock.request(this.loop);
    }
    this.emit();
  };

  play() {
    if (this.playing) return;
    if (this.time >= this.cast.duration) this.restart();
    this.playing = true;
    this.lastTick = this.clock.now();
    this.frame = this.clock.request(this.loop);
    this.emit();
  }

  pause() {
    if (this.frame !== null) this.clock.cancel(this.frame);
    this.frame = null;
    this.playing = false;
    this.emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(t: number) {
    const target = Math.max(0, Math.min(t, this.cast.duration));
    if (target < this.time) this.restart();
    this.advance(target);
    this.lastTick = this.clock.now();
    this.emit();
  }

  /** Switch to another timeline of the same recording (pauses shortened or not),
   * keeping the position in the recording. */
  setCast(cast: Cast) {
    const fraction = this.cast.duration > 0 ? this.time / this.cast.duration : 0;
    this.cast = cast;
    this.restart();
    this.advance(fraction * cast.duration);
    this.emit();
  }

  dispose() {
    if (this.frame !== null) this.clock.cancel(this.frame);
    this.frame = null;
  }
}
