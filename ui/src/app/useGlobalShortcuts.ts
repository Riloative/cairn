import { useEffect } from "react";
import { availableActions, useActions } from "@/lib/actions";
import { isMac } from "@/lib/platform";
import { matchesShortcut } from "@/lib/shortcuts";

/** True when the event comes from an editable field other than xterm's hidden textarea. */
export function isTypingInField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".xterm")) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable === true
  );
}

/**
 * While a remote desktop has focus every key goes to the server, except these: the
 * palette, tab switching and lock stay reachable.
 */
const RDP_PASSTHROUGH = new Set(["palette.open", "tabs.next", "tabs.previous", "vault.lock"]);

function inRemoteDesktop(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("[data-rdp-capture]") !== null;
}

/** Run the action whose shortcut matches a keydown anywhere in the window. */
export function useGlobalShortcuts() {
  useEffect(() => {
    const mac = isMac();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      const actions = availableActions(useActions.getState().actions);
      const hit = actions.find((a) => a.shortcut && matchesShortcut(a.shortcut, e, mac));
      if (!hit) return;
      if (inRemoteDesktop(e.target) && !RDP_PASSTHROUGH.has(hit.id)) return;
      if (hit.scope && hit.scope !== "global" && isTypingInField(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      void hit.run();
    };
    // Capture phase so shortcuts work even when a focused widget stops propagation.
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);
}
