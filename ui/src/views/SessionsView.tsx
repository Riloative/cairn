import { TerminalSquare } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { useSessions } from "@/stores/sessions";
import { useUi } from "@/stores/ui";
import { PROTOCOL_LABEL } from "@/app/protocol";

export function SessionsView() {
  const tabs = useSessions((s) => s.tabs);
  const activeId = useSessions((s) => s.activeId);
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  const active = tabs.find((t) => t.id === activeId);

  if (!active) {
    return (
      <EmptyState
        icon={<TerminalSquare size={20} />}
        title="No open sessions"
        description="Open the command palette to connect to a device or start a local shell."
        action={{
          label: "Open command palette",
          onClick: () => setPaletteOpen(true),
          shortcut: "Mod+K",
        }}
      />
    );
  }
  // Terminal and RDP views mount here (M2/M7).
  return (
    <div className="flex h-full items-center justify-center text-fg-muted">
      {PROTOCOL_LABEL[active.protocol]} · {active.title}
    </div>
  );
}
