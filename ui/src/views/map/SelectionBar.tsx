import { RadioTower, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { InventorySnapshot } from "@/lib/ipc";
import { openSessions, terminalDevices } from "./nodeActions";

/** Shown when two or more devices are selected: open sessions to all, or broadcast. */
export function SelectionBar({
  selection,
  inv,
}: {
  selection: readonly string[];
  inv: InventorySnapshot;
}) {
  const ids = new Set(selection.filter((s) => s.startsWith("d:")).map((s) => Number(s.slice(2))));
  const devices = inv.devices.filter((d) => ids.has(d.id));
  if (devices.length < 2) return null;
  const usable = terminalDevices(devices).length;
  return (
    <div
      role="toolbar"
      aria-label="Selected devices"
      className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-[13px] shadow-md animate-pop-in"
    >
      <span className="text-fg-muted">{devices.length} devices selected</span>
      <Button
        size="sm"
        variant="ghost"
        disabled={usable === 0}
        onClick={() => void openSessions(devices, false)}
      >
        <TerminalSquare size={14} /> Open sessions
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={usable < 2}
        onClick={() => void openSessions(devices, true)}
      >
        <RadioTower size={14} /> Broadcast…
      </Button>
    </div>
  );
}
