import { ArrowDownToLine, ArrowUpFromLine, Files, Zap } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/Menu";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import { DEFAULT_LINES, useSerial } from "@/stores/serial";
import type { SessionTab } from "@/stores/sessions";
import { sendBreak, setLine, supportsBreak } from "./serialControls";

function LineToggle({
  tabId,
  line,
  on,
  disabled,
}: {
  tabId: string;
  line: "dtr" | "rts";
  on: boolean;
  disabled: boolean;
}) {
  const name = line.toUpperCase();
  return (
    <Tooltip label={`${name} ${on ? "asserted" : "cleared"} — click to toggle`}>
      <button
        type="button"
        aria-pressed={on}
        aria-label={name}
        disabled={disabled}
        onClick={() => void setLine(tabId, line, !on)}
        className={cn(
          "flex h-6 items-center gap-1.5 rounded-md px-2 font-mono text-[11px] transition-colors duration-150 disabled:opacity-50",
          "hover:bg-surface-raised",
        )}
      >
        <span
          aria-hidden
          className={cn("size-1.5 rounded-full", on ? "bg-success" : "bg-fg-subtle/50")}
        />
        {name}
      </button>
    </Tooltip>
  );
}

/** Protocol controls in the terminal header: DTR/RTS, BREAK and file transfers. */
export function SessionControls({ tab }: { tab: SessionTab }) {
  const lines = useSerial((s) => s.lines[tab.id]) ?? DEFAULT_LINES;
  const transfer = useSerial((s) => s.transfers[tab.id]);
  const openDialog = useSerial((s) => s.openDialog);
  if (!supportsBreak(tab.protocol)) return null;
  const offline = tab.state !== "connected";
  const running = transfer?.phase === "running";
  const pct =
    running && transfer.total
      ? Math.min(100, Math.round((transfer.bytes / transfer.total) * 100))
      : null;

  return (
    <div className="flex items-center gap-1">
      {tab.protocol === "serial" && (
        <>
          <LineToggle tabId={tab.id} line="dtr" on={lines.dtr} disabled={offline || running} />
          <LineToggle tabId={tab.id} line="rts" on={lines.rts} disabled={offline || running} />
        </>
      )}
      <Tooltip label="Send BREAK (ROMMON / password recovery)">
        <Button
          size="sm"
          variant="ghost"
          disabled={offline || running}
          onClick={() => void sendBreak(tab.id)}
        >
          <Zap size={13} />
          Break
        </Button>
      </Tooltip>
      {tab.protocol === "serial" &&
        (running ? (
          <Button size="sm" variant="ghost" onClick={() => openDialog(tab.id, transfer.direction)}>
            <Files size={13} />
            {pct === null ? "Transferring…" : `Transfer ${pct}%`}
          </Button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" disabled={offline}>
                <Files size={13} />
                Transfer
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                icon={<ArrowUpFromLine size={14} />}
                onSelect={() => openDialog(tab.id, "send")}
              >
                Send file…
              </DropdownMenuItem>
              <DropdownMenuItem
                icon={<ArrowDownToLine size={14} />}
                onSelect={() => openDialog(tab.id, "receive")}
              >
                Receive file…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ))}
    </div>
  );
}
