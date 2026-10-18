import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import type { TerminalProfile } from "@/lib/ipc";
import { toXtermTheme, type Palette } from "./palette";

/**
 * Live xterm.js instances, keyed by tab id. They live outside React so a terminal keeps
 * its scrollback and state while its tab is hidden or the view changes; panes only
 * attach and detach the terminal's DOM element.
 */
export interface TerminalHandle {
  tabId: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  serialize: SerializeAddon;
  /** Persistent host element that xterm renders into. */
  element: HTMLDivElement;
  opened: boolean;
  webgl: WebglAddon | null;
  /** Called with link URLs the user explicitly clicked. */
  onLink: (url: string) => void;
}

const handles = new Map<string, TerminalHandle>();

export function terminalOptions(profile: TerminalProfile, palette: Palette): ITerminalOptions {
  return {
    fontFamily: `"${profile.fontFamily}", "JetBrains Mono Variable", ui-monospace, monospace`,
    fontSize: profile.fontSize,
    lineHeight: profile.lineHeight,
    cursorStyle: profile.cursorStyle,
    cursorBlink: profile.cursorBlink,
    scrollback: profile.scrollback,
    theme: toXtermTheme(palette, profile.opacity),
    allowTransparency: profile.opacity < 1,
    // Bell handling is done by Cairn (visual flash / sound) via onBell.
    allowProposedApi: true,
    macOptionIsMeta: true,
    rightClickSelectsWord: false,
    scrollOnUserInput: true,
    drawBoldTextInBrightColors: false,
  };
}

export function createTerminal(
  tabId: string,
  profile: TerminalProfile,
  palette: Palette,
  onLink: (url: string) => void,
): TerminalHandle {
  const term = new Terminal(terminalOptions(profile, palette));
  const fit = new FitAddon();
  const search = new SearchAddon();
  const serialize = new SerializeAddon();
  const unicode = new Unicode11Addon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(serialize);
  term.loadAddon(unicode);
  term.unicode.activeVersion = "11";
  term.loadAddon(new ImageAddon({ sixelSupport: true, iipSupport: true }));
  const handle: TerminalHandle = {
    tabId,
    term,
    fit,
    search,
    serialize,
    element: document.createElement("div"),
    opened: false,
    webgl: null,
    onLink,
  };
  handle.element.className = "h-full w-full";
  // Links open only on an explicit click (never automatically), via the system browser.
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      event.preventDefault();
      handle.onLink(uri);
    }),
  );
  handles.set(tabId, handle);
  return handle;
}

/** Open the terminal into its element once it is in the document, then enable WebGL. */
export function ensureOpened(handle: TerminalHandle) {
  if (handle.opened || !handle.element.isConnected) return;
  handle.term.open(handle.element);
  handle.opened = true;
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      handle.webgl = null;
    });
    handle.term.loadAddon(webgl);
    handle.webgl = webgl;
  } catch {
    // No WebGL (e.g. software rendering): xterm falls back to its DOM renderer.
    handle.webgl = null;
  }
}

export function getTerminal(tabId: string): TerminalHandle | undefined {
  return handles.get(tabId);
}

export function allTerminals(): TerminalHandle[] {
  return [...handles.values()];
}

export function disposeTerminal(tabId: string) {
  const h = handles.get(tabId);
  if (!h) return;
  handles.delete(tabId);
  h.term.dispose();
  h.element.remove();
}

/** Apply new profile/palette options to a live terminal. */
export function applyOptions(handle: TerminalHandle, profile: TerminalProfile, palette: Palette) {
  const opts = terminalOptions(profile, palette);
  // `scrollback` can be changed live; xterm trims or extends the buffer.
  for (const [k, v] of Object.entries(opts)) {
    (handle.term.options as Record<string, unknown>)[k] = v;
  }
  // Colors are baked into the WebGL glyph atlas; rebuild it and repaint everything.
  handle.webgl?.clearTextureAtlas();
  handle.term.refresh(0, handle.term.rows - 1);
}
