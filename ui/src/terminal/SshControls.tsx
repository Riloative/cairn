import { ArrowRightLeft, FolderTree } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import { useFiles } from "@/stores/files";
import { useForwards } from "@/stores/forwards";
import type { SessionTab } from "@/stores/sessions";
import { useUi } from "@/stores/ui";
import { backendSessionId } from "./controller";

/** SSH tab tools in the terminal header: the file panel and port forwards. */
export function SshControls({ tab }: { tab: SessionTab }) {
  const open = useFiles((s) => s.panels[tab.id]?.open ?? false);
  const forwards = useForwards(
    (s) => s.active.filter((f) => f.sessionId === backendSessionId(tab.id)).length,
  );
  if (tab.protocol !== "ssh") return null;
  const offline = tab.state !== "connected";
  return (
    <div className="flex items-center gap-1">
      <Tooltip label="Files (SFTP / SCP)">
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={open}
          disabled={offline}
          className={cn(open && "bg-accent-subtle")}
          onClick={() => useFiles.getState().toggle(tab.id, backendSessionId(tab.id))}
        >
          <FolderTree size={13} /> Files
        </Button>
      </Tooltip>
      <Tooltip label="Port forwards over this session">
        <Button
          size="sm"
          variant="ghost"
          disabled={offline}
          onClick={() => {
            useForwards.getState().setPreselectTab(tab.id);
            useUi.getState().openTool("forwards");
          }}
        >
          <ArrowRightLeft size={13} /> Forwards{forwards > 0 && ` (${forwards})`}
        </Button>
      </Tooltip>
    </div>
  );
}
