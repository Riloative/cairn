import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { ensureOpened, getTerminal, promoteRenderer } from "./registry";

/**
 * Hosts a tab's xterm element. Mounting attaches the persistent element; unmounting only
 * detaches it, so scrollback survives tab and view switches.
 */
export function TerminalPane({ tabId, active }: { tabId: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const handle = getTerminal(tabId);
    if (!host || !handle) return;
    host.appendChild(handle.element);
    ensureOpened(handle);
    const fit = () => {
      // Hidden panes report 0×0; fitting then would collapse the terminal.
      if (host.clientWidth > 0 && host.clientHeight > 0) handle.fit.fit();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    return () => {
      ro.disconnect();
      handle.element.remove();
    };
  }, [tabId]);

  useEffect(() => {
    if (!active) return;
    const handle = getTerminal(tabId);
    if (!handle) return;
    promoteRenderer(handle);
    // Refit after becoming visible, then focus for typing.
    requestAnimationFrame(() => {
      if (hostRef.current && hostRef.current.clientWidth > 0) handle.fit.fit();
      handle.term.focus();
    });
  }, [active, tabId]);

  return (
    <div
      ref={hostRef}
      data-selectable
      className={cn("absolute inset-0 px-2 pt-1 pb-1", !active && "invisible")}
      aria-hidden={!active}
    />
  );
}
