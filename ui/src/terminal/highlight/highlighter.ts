import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import type { PaletteColors } from "../palette";
import { bufferLineText, cellRange } from "./cells";
import { findMatches, type CompiledRule } from "./engine";
import type { HighlightStyle } from "./types";

interface LineState {
  text: string;
  marker: IMarker;
  decorations: IDecoration[];
}

/** Lines kept decorated above/below the viewport, in screens. */
const KEEP_SCREENS = 2;

function resolveColor(color: string | null, palette: PaletteColors): string | undefined {
  if (!color) return undefined;
  if (color.startsWith("#")) return color;
  return (palette as unknown as Record<string, string>)[color];
}

/**
 * Applies highlighting rules to the visible part of a terminal as decorations. The byte
 * stream, scrollback contents, copy/paste, logs and recordings are never modified.
 */
export class Highlighter {
  private lines = new Map<number, LineState>();
  private scheduled = false;
  private disposables: { dispose(): void }[] = [];

  constructor(
    private readonly term: Terminal,
    private readonly getRules: () => readonly CompiledRule[],
    private readonly getPalette: () => PaletteColors,
  ) {
    const schedule = () => this.schedule();
    this.disposables.push(
      term.onWriteParsed(schedule),
      term.onScroll(schedule),
      term.onResize(() => this.reset()),
      term.buffer.onBufferChange(() => this.reset()),
    );
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.clear();
  }

  /** Rules or colors changed: redo everything. */
  reset() {
    this.clear();
    this.schedule();
  }

  private clear() {
    for (const s of this.lines.values()) this.disposeLine(s);
    this.lines.clear();
  }

  private disposeLine(s: LineState) {
    for (const d of s.decorations) d.dispose();
    s.marker.dispose();
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      this.refresh();
    });
  }

  private refresh() {
    const buf = this.term.buffer.active;
    // Full-screen apps (vim, less, htop) use the alternate buffer: leave them alone.
    if (buf.type === "alternate") {
      this.clear();
      return;
    }
    const rules = this.getRules();
    const palette = this.getPalette();
    const rows = this.term.rows;
    const top = buf.viewportY;
    const cursorAbs = buf.baseY + buf.cursorY;

    // Forget lines far from the viewport (re-done if the user scrolls back).
    for (const [y, s] of this.lines) {
      if (
        y < top - rows * KEEP_SCREENS ||
        y > top + rows * (KEEP_SCREENS + 1) ||
        s.marker.isDisposed
      ) {
        this.disposeLine(s);
        this.lines.delete(y);
      }
    }

    for (let y = top; y < top + rows; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const map = bufferLineText(line, this.term.cols);
      const prev = this.lines.get(y);
      if (prev && prev.text === map.text && !prev.marker.isDisposed) continue;
      if (prev) {
        this.disposeLine(prev);
        this.lines.delete(y);
      }
      if (rules.length === 0 || !map.text) continue;
      const matches = findMatches(map.text, rules);
      if (matches.length === 0) continue;
      const marker = this.term.registerMarker(y - cursorAbs);
      if (!marker) continue;
      const decorations: IDecoration[] = [];
      for (const m of matches) {
        const { x, width } = cellRange(map, m.start, m.end);
        const d = this.decorate(marker, x, width, m.style, palette, map.text.slice(m.start, m.end));
        if (d) decorations.push(d);
      }
      this.lines.set(y, { text: map.text, marker, decorations });
    }
  }

  private decorate(
    marker: IMarker,
    x: number,
    width: number,
    style: HighlightStyle,
    palette: PaletteColors,
    text: string,
  ): IDecoration | undefined {
    const fg = resolveColor(style.fg, palette);
    const bg = resolveColor(style.bg, palette);
    const deco = this.term.registerDecoration({
      marker,
      x,
      width,
      layer: "top",
      foregroundColor: fg,
      backgroundColor: bg,
    });
    if (deco && (style.bold || style.underline)) {
      const font = this.term.options;
      deco.onRender((el) => {
        el.style.pointerEvents = "none";
        if (style.underline) el.style.borderBottom = `1px solid ${fg ?? palette.foreground}`;
        if (style.bold && el.childElementCount === 0) {
          // Bold is drawn as an opaque overlay of the same text (monospace widths match).
          const span = document.createElement("span");
          span.textContent = text;
          span.style.cssText = [
            "display:block",
            "white-space:pre",
            "overflow:hidden",
            "font-weight:bold",
            `font-family:${font.fontFamily ?? "monospace"}`,
            `font-size:${String(font.fontSize ?? 13)}px`,
            `line-height:${el.style.height}`,
            `color:${fg ?? palette.foreground}`,
            `background:${bg ?? palette.background}`,
          ].join(";");
          el.appendChild(span);
        }
      });
    }
    return deco;
  }
}
