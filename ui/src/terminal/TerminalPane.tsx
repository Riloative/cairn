import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { ensureOpened, getTerminal, paintHost, promoteRenderer } from "./registry";

/**
 * Hosts a tab's xterm element. Mounting attaches the persistent element; unmounting only
 * detaches it, so scrollback survives tab and view switches.
 *
 * Only the active pane is fitted while the window resizes: hidden panes keep their
 * layout (`visibility: hidden`), so without this every open terminal would refit, and
 * resize its pty, on every observer tick. A pane is fitted again when it becomes active.
 */
export function TerminalPane({ tabId, active }: { tabId: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Read by the resize observer, which outlives any one render.
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    const host = hostRef.current;
    const handle = getTerminal(tabId);
    if (!host || !handle) return;
    host.appendChild(handle.element);
    ensureOpened(handle);
    paintHost(handle);
    const fit = () => {
      // Hidden panes report 0×0; fitting then would collapse the terminal.
      if (host.clientWidth > 0 && host.clientHeight > 0) handle.fit.fit();
    };
    fit();
    const ro = new ResizeObserver(() => {
      if (activeRef.current) fit();
    });
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
    // Refit after becoming visible (the window may have changed size while the pane
    // was hidden), then focus for typing.
    const frame = requestAnimationFrame(() => {
      const host = hostRef.current;
      if (host && host.clientWidth > 0 && host.clientHeight > 0) handle.fit.fit();
      handle.term.focus();
    });
    return () => cancelAnimationFrame(frame);
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
