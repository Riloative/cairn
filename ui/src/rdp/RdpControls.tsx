import { Command, Expand, Keyboard, Maximize2, Scan } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import { isMac } from "@/lib/platform";
import { useRdp } from "@/stores/rdp";
import type { SessionTab } from "@/stores/sessions";
import { ctrlAltDel } from "./controller";

/** RDP tab tools in the session header: scaling, ⌘ mapping, Ctrl+Alt+Del, fullscreen. */
export function RdpControls({ tab }: { tab: SessionTab }) {
  const ui = useRdp((s) => s.byTab[tab.id]);
  if (tab.protocol !== "rdp" || !ui) return null;
  const offline = tab.state !== "connected";
  const patch = (p: Parameters<ReturnType<typeof useRdp.getState>["patch"]>[1]) =>
    useRdp.getState().patch(tab.id, p);
  return (
    <div className="flex items-center gap-1">
      {ui.width > 0 && (
        <span className="mr-1 font-mono text-xs text-fg-subtle">
          {ui.width}×{ui.height}
        </span>
      )}
      <Tooltip label={ui.scale === "fit" ? "Show at actual size" : "Fit to the window"}>
        <Button
          size="sm"
          variant="ghost"
          aria-label={ui.scale === "fit" ? "Actual size" : "Fit to window"}
          onClick={() => patch({ scale: ui.scale === "fit" ? "actual" : "fit" })}
        >
          {ui.scale === "fit" ? <Scan size={13} /> : <Maximize2 size={13} />}
          {ui.scale === "fit" ? "Fit" : "1:1"}
        </Button>
      </Tooltip>
      {isMac() && (
        <Tooltip label="Send ⌘ as Ctrl (⌘C, ⌘V and ⌘Z act as on the Mac)">
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={ui.cmdAsCtrl}
            className={cn(ui.cmdAsCtrl && "bg-accent-subtle")}
            onClick={() => patch({ cmdAsCtrl: !ui.cmdAsCtrl })}
          >
            <Command size={13} /> as Ctrl
          </Button>
        </Tooltip>
      )}
      <Tooltip label="Send Ctrl+Alt+Del">
        <Button size="sm" variant="ghost" disabled={offline} onClick={() => ctrlAltDel(tab.id)}>
          <Keyboard size={13} /> Ctrl+Alt+Del
        </Button>
      </Tooltip>
      <Tooltip label="Full screen" shortcut="F11">
        <Button
          size="sm"
          variant="ghost"
          aria-label="Full screen"
          onClick={() => patch({ fullscreen: true })}
        >
          <Expand size={13} />
        </Button>
      </Tooltip>
    </div>
  );
}
