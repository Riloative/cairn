import { cn } from "@/lib/cn";
import type { SessionTab } from "@/stores/sessions";
import { headerTint, type HeaderTint } from "./tint";
import { PROTOCOL_LABEL, STATE_LABEL } from "@/app/protocol";

const TINT_CLASS: Record<HeaderTint, string> = {
  local: "bg-surface",
  remote: "bg-tint-remote",
  serial: "bg-tint-serial",
  privileged: "bg-tint-privileged",
};

/** Context-colored bar above the terminal (Ptyxis-style). */
export function TerminalHeader({ tab, privileged }: { tab: SessionTab; privileged: boolean }) {
  const tint = headerTint(tab, privileged);
  return (
    <div
      data-tint={tint}
      className={cn(
        "flex h-9 shrink-0 items-center gap-3 border-b border-border px-4 text-[13px] transition-colors duration-200",
        TINT_CLASS[tint],
      )}
    >
      <span className="font-medium">{tab.title}</span>
      {tab.title !== PROTOCOL_LABEL[tab.protocol] && (
        <span className="text-xs text-fg-muted">{PROTOCOL_LABEL[tab.protocol]}</span>
      )}
      {privileged && (
        <span className="rounded-sm bg-danger px-1.5 py-px text-[11px] font-medium text-white">
          privileged
        </span>
      )}
      <span className="flex-1" />
      <span className="text-xs text-fg-subtle">{STATE_LABEL[tab.state]}</span>
    </div>
  );
}
