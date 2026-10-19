import type { Terminal } from "@xterm/xterm";
import { create } from "zustand";

/**
 * Privileged-prompt detection: after output is parsed, the text left of the cursor is
 * matched against the user's prompt regexes (Settings → Terminal). A match tints the
 * header red. Detection only reads the rendered buffer; the byte stream is untouched.
 */

export function compilePatterns(patterns: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p));
    } catch {
      // Invalid user regexes are flagged in Settings; skip them here.
    }
  }
  return out;
}

export function isPrivilegedPrompt(promptText: string, patterns: readonly RegExp[]): boolean {
  const text = promptText.replace(/\s+$/, " ").trimStart();
  if (text.length === 0 || text.length > 200) return false;
  return patterns.some((re) => re.test(text) || re.test(text.trimEnd()));
}

/** Text on the cursor's line, left of the cursor. */
export function promptBeforeCursor(term: Terminal): string {
  const buf = term.buffer.active;
  const line = buf.getLine(buf.baseY + buf.cursorY);
  return line ? line.translateToString(false, 0, buf.cursorX) : "";
}

interface PrivilegeState {
  byTab: Record<string, boolean>;
  set: (tabId: string, value: boolean) => void;
  remove: (tabId: string) => void;
}

export const usePrivilegeStore = create<PrivilegeState>((set, get) => ({
  byTab: {},
  set: (tabId, value) => {
    if (get().byTab[tabId] !== value) set({ byTab: { ...get().byTab, [tabId]: value } });
  },
  remove: (tabId) => {
    set({ byTab: Object.fromEntries(Object.entries(get().byTab).filter(([k]) => k !== tabId)) });
  },
}));

export function usePrivileged(tabId: string | null): boolean {
  return usePrivilegeStore((s) => (tabId ? (s.byTab[tabId] ?? false) : false));
}

/** Watch a terminal; `getPatterns` is read on each check so Settings changes apply live. */
export function trackPrivilege(
  tabId: string,
  term: Terminal,
  getPatterns: () => readonly RegExp[],
): () => void {
  let scheduled = false;
  const check = () => {
    scheduled = false;
    usePrivilegeStore
      .getState()
      .set(tabId, isPrivilegedPrompt(promptBeforeCursor(term), getPatterns()));
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(check);
  };
  const sub = term.onWriteParsed(schedule);
  return () => {
    sub.dispose();
    usePrivilegeStore.getState().remove(tabId);
  };
}
