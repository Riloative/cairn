import { useEffect } from "react";
import { activityPing } from "@/lib/ipc";

/** How often at most to tell the backend the user is active (idle auto-lock). */
export const PING_INTERVAL_MS = 30_000;

export function useActivityPing() {
  useEffect(() => {
    let last = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now - last < PING_INTERVAL_MS) return;
      last = now;
      // A failed ping only delays auto-lock bookkeeping; nothing to report.
      activityPing().catch(() => {});
    };
    const events = ["keydown", "pointerdown", "pointermove", "wheel"] as const;
    for (const ev of events) window.addEventListener(ev, onActivity, { passive: true });
    return () => {
      for (const ev of events) window.removeEventListener(ev, onActivity);
    };
  }, []);
}
