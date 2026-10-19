import type { Snippet } from "@/lib/ipc";
import { renderSnippet, snippetLines } from "@/lib/snippets";
import { useNotifications } from "@/stores/notifications";
import { useSessions } from "@/stores/sessions";
import { useSnippets } from "@/stores/snippets";
import { profileById, useTerminalPrefs } from "@/stores/terminalPrefs";
import { profileIdOf, writeToTab } from "./controller";
import { encodeInput } from "./encoding";
import { getTerminal } from "./registry";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The tab a snippet goes to: the given one, else the active terminal tab. */
function targetTab(tabId?: string): string | null {
  const { tabs, activeId } = useSessions.getState();
  const id = tabId ?? activeId;
  const tab = tabs.find((t) => t.id === id);
  return tab && tab.protocol !== "rdp" ? tab.id : null;
}

/**
 * Type text into a tab: lines are submitted one by one (with the profile's per-line
 * delay for slow gear), the last line is left for the user to review.
 */
export async function typeIntoTab(tabId: string, text: string) {
  const profile = profileById(useTerminalPrefs.getState().prefs, profileIdOf(tabId));
  const lines = snippetLines(text);
  for (const [i, line] of lines.entries()) {
    await writeToTab(tabId, encodeInput(line));
    if (i < lines.length - 1 && profile.pasteLineDelayMs > 0) await sleep(profile.pasteLineDelayMs);
  }
  getTerminal(tabId)?.term.focus();
}

/** Insert a snippet, asking for its variables first when it has any. */
export function runSnippet(snippet: Snippet, tabId?: string) {
  const target = targetTab(tabId);
  if (!target) {
    useNotifications.getState().notify({
      variant: "info",
      title: "Open a session first",
      description: "Snippets are typed into the active terminal tab.",
    });
    return;
  }
  if (snippet.variables.length > 0) {
    useSnippets.getState().setPending({ snippet, tabId: target });
    return;
  }
  void typeIntoTab(target, renderSnippet(snippet.body, {}));
}
