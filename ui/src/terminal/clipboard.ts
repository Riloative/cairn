import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useNotifications } from "@/stores/notifications";
import { useTerminalPrefs, profileById } from "@/stores/terminalPrefs";
import { useTerminalUi } from "@/stores/terminalUi";
import { encodeInput } from "./encoding";
import { slowPasteChunks, isMultiline } from "./paste";
import { getTerminal } from "./registry";

/** Writes go through this so tests and the controller can share one sender. */
let sender: (tabId: string, bytes: Uint8Array) => Promise<void> = () => Promise.resolve();

export function setPasteSender(fn: (tabId: string, bytes: Uint8Array) => Promise<void>) {
  sender = fn;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Paste into a terminal tab with paste safety: multi-line text asks first (showing the
 * line count); a profile's per-line delay sends one line at a time for slow gear.
 */
export async function pasteIntoTab(tabId: string, text: string, profileId?: string) {
  const handle = getTerminal(tabId);
  if (!handle || !text) return;
  const prefs = useTerminalPrefs.getState().prefs;
  const delay = profileById(prefs, profileId).pasteLineDelayMs;
  let slow = false;
  if (isMultiline(text) && prefs.confirmMultilinePaste) {
    const decision = await useTerminalUi.getState().confirmPaste(tabId, text);
    if (decision === "cancel") return;
    slow = decision === "slow";
  } else if (isMultiline(text) && delay > 0) {
    slow = true;
  }
  if (slow) {
    for (const chunk of slowPasteChunks(text)) {
      await sender(tabId, encodeInput(chunk));
      await sleep(Math.max(delay, 50));
    }
  } else {
    // xterm applies bracketed paste mode and newline conversion.
    handle.term.paste(text);
  }
  handle.term.focus();
}

export async function pasteFromClipboard(tabId: string, profileId?: string) {
  try {
    await pasteIntoTab(tabId, await readText(), profileId);
  } catch (e) {
    useNotifications.getState().notifyError(e, "Could not read the clipboard");
  }
}

export async function copySelection(tabId: string): Promise<boolean> {
  const sel = getTerminal(tabId)?.term.getSelection();
  if (!sel) return false;
  try {
    await writeText(sel);
    return true;
  } catch (e) {
    useNotifications.getState().notifyError(e, "Could not copy to the clipboard");
    return false;
  }
}
