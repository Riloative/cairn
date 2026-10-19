import { RadioTower } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useBroadcast } from "@/stores/broadcast";
import { useSessions } from "@/stores/sessions";

/** Shown while broadcast is on: who receives input, and a way to stop. */
export function BroadcastBanner() {
  const members = useBroadcast((s) => s.members);
  const tabs = useSessions((s) => s.tabs);
  if (members.length === 0) return null;
  const names = members.map((id) => tabs.find((t) => t.id === id)?.title ?? id);
  return (
    <div
      role="status"
      aria-label="Broadcast active"
      className="flex h-9 shrink-0 items-center gap-2 border-b border-warning/50 bg-warning/15 px-4 text-[13px]"
    >
      <RadioTower size={14} className="shrink-0 text-warning" aria-hidden />
      <span className="font-medium">Broadcasting to {members.length} sessions:</span>
      <span className="min-w-0 flex-1 truncate text-fg-muted">{names.join(", ")}</span>
      <Button size="sm" variant="secondary" onClick={() => useBroadcast.getState().stop()}>
        Stop
      </Button>
    </div>
  );
}
