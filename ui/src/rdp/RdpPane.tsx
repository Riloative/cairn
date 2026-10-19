import { Minimize2, MonitorX, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { useRdp } from "@/stores/rdp";
import type { SessionTab } from "@/stores/sessions";
import { attachRdp, focusRdp, layoutRdp } from "./attach";
import { closeRdpTab, reconnectRdp, resizeRdp } from "./controller";

/** Wait this long after the view stops resizing before asking the server to follow. */
const RESIZE_DEBOUNCE_MS = 400;

/**
 * Hosts an RDP tab's canvas: scaling, keyboard/mouse capture, clipboard sync on focus,
 * full screen, and the connecting / disconnected states.
 */
export function RdpPane({ tab, active }: { tab: SessionTab; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ui = useRdp((s) => s.byTab[tab.id]);
  const [box, setBox] = useState({ width: 0, height: 0 });

  // Attach the persistent canvas and capture its input.
  useEffect(() => {
    const host = hostRef.current;
    return host ? attachRdp(tab.id, host, tab.title) : undefined;
  }, [tab.id, tab.title]);

  // Track the host size; ask the server to follow it when the desktop is not fixed.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      const rect = { width: host.clientWidth, height: host.clientHeight };
      setBox(rect);
      if (rect.width === 0 || rect.height === 0) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (useRdp.getState().byTab[tab.id]?.followView) {
          const dpr = window.devicePixelRatio || 1;
          resizeRdp(tab.id, {
            width: Math.round(rect.width * dpr),
            height: Math.round(rect.height * dpr),
            scale: Math.round(dpr * 100),
          });
        }
      }, RESIZE_DEBOUNCE_MS);
    });
    ro.observe(host);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, [tab.id, ui?.fullscreen]);

  // Focus the desktop when the tab becomes active.
  useEffect(() => {
    if (active && tab.state === "connected") requestAnimationFrame(() => focusRdp(tab.id));
  }, [active, tab.state, tab.id]);

  // Leave full screen with the tab.
  useEffect(() => {
    if (!active && ui?.fullscreen) useRdp.getState().patch(tab.id, { fullscreen: false });
  }, [active, ui?.fullscreen, tab.id]);

  useEffect(() => layoutRdp(tab.id, box), [tab.id, ui, box]);

  const connected = tab.state === "connected";
  const ended = tab.state === "disconnected" || tab.state === "error";
  return (
    <div
      className={cn(
        "absolute inset-0 flex flex-col bg-bg",
        ui?.fullscreen && "fixed z-[60]",
        !active && "invisible",
      )}
      aria-hidden={!active}
    >
      {ui?.fullscreen && (
        <div className="group absolute inset-x-0 top-0 z-10 flex h-6 justify-center">
          <Button
            size="sm"
            variant="secondary"
            className="opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => useRdp.getState().patch(tab.id, { fullscreen: false })}
          >
            <Minimize2 size={13} /> Exit full screen
          </Button>
        </div>
      )}
      <div
        ref={hostRef}
        className={cn(
          "relative min-h-0 flex-1",
          ui?.scale === "actual"
            ? "overflow-auto"
            : "flex items-center justify-center overflow-hidden",
          !connected && "opacity-60",
        )}
      />
      {tab.state === "connecting" && (ui?.width ?? 0) === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8">
          <Skeleton className="h-2/3 w-2/3 max-w-3xl" />
          <p role="status" className="text-xs text-fg-muted">
            {tab.detail ?? "Connecting"}…
          </p>
        </div>
      )}
      {ended && (
        <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center animate-pop-in">
          <div
            role="status"
            className="pointer-events-auto flex max-w-xl items-center gap-4 rounded-xl border border-border bg-surface-raised px-4 py-3 shadow-lg"
          >
            <MonitorX
              size={18}
              className={cn("shrink-0", tab.state === "error" ? "text-danger" : "text-fg-muted")}
            />
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {tab.state === "error" ? "The remote desktop disconnected" : "Session ended"}
              </p>
              <p className="text-xs text-fg-muted" title={tab.detail}>
                {tab.detail}
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => closeRdpTab(tab.id)}>
              Close tab
            </Button>
            <Button size="sm" variant="primary" onClick={() => reconnectRdp(tab.id)}>
              <RotateCw size={14} /> Reconnect
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
