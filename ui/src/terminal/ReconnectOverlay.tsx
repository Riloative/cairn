import { RotateCw, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Shortcut } from "@/components/ui/Kbd";
import { useReconnect } from "@/stores/reconnect";
import type { SessionTab } from "@/stores/sessions";
import { cancelAutoReconnect, closeTab, reconnectTab } from "./controller";

function useCountdown(at: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [at]);
  return at === null ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/** Shown over a dropped SSH session: reason, auto-reconnect countdown, actions. */
export function ReconnectOverlay({ tab }: { tab: SessionTab }) {
  const state = useReconnect((s) => s.byTab[tab.id]);
  const seconds = useCountdown(state?.nextAt ?? null);
  if (!state) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center animate-pop-in">
      <div
        role="status"
        className="pointer-events-auto flex max-w-xl items-center gap-4 rounded-xl border border-border bg-surface-raised px-4 py-3 shadow-lg"
      >
        <Unplug size={18} className="shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">Connection lost</p>
          <p className="truncate text-xs text-fg-muted" title={state.message}>
            {seconds !== null
              ? `Reconnecting in ${seconds}s (attempt ${state.attempt + 1})`
              : state.message || "The session ended unexpectedly."}
          </p>
        </div>
        {seconds !== null && (
          <Button size="sm" variant="ghost" onClick={() => cancelAutoReconnect(tab.id)}>
            Stop
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => closeTab(tab.id)}>
          Close tab
        </Button>
        <Button size="sm" variant="primary" onClick={() => void reconnectTab(tab.id)}>
          <RotateCw size={14} />
          Reconnect
          <span className="opacity-80">
            <Shortcut keys="Enter" />
          </span>
        </Button>
      </div>
    </div>
  );
}
