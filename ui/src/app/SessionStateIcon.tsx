import { cn } from "@/lib/cn";
import type { SessionState } from "@/stores/sessions";
import { STATE_LABEL } from "./protocol";

/** Small state indicator next to a tab title. */
export function SessionStateIcon({ state }: { state: SessionState }) {
  return (
    <span
      role="img"
      aria-label={STATE_LABEL[state]}
      title={STATE_LABEL[state]}
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        state === "connected" && "bg-success",
        state === "connecting" && "animate-shimmer bg-warning",
        state === "disconnected" && "bg-fg-subtle",
        state === "error" && "bg-danger",
      )}
    />
  );
}
