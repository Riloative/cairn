import { Plus, X } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import { useSessions } from "@/stores/sessions";
import { useUi } from "@/stores/ui";
import { closeTab as close } from "@/terminal/controller";
import { PROTOCOL_DOT, PROTOCOL_LABEL } from "./protocol";
import { SessionStateIcon } from "./SessionStateIcon";

export function TabBar() {
  const tabs = useSessions((s) => s.tabs);
  const activeId = useSessions((s) => s.activeId);
  const activate = useSessions((s) => s.activate);
  const setView = useUi((s) => s.setView);
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);

  return (
    <div className="flex h-10 shrink-0 items-end gap-1 overflow-x-auto px-2">
      <div role="tablist" aria-label="Sessions" className="flex items-end gap-1">
        {tabs.map((t) => {
          const active = t.id === activeId;
          return (
            <div
              key={t.id}
              role="tab"
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              onClick={() => {
                activate(t.id);
                setView("sessions");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") activate(t.id);
              }}
              onAuxClick={(e) => e.button === 1 && close(t.id)}
              className={cn(
                "group flex h-8 max-w-56 min-w-32 items-center gap-2 rounded-t-lg px-3 text-[13px] transition-colors duration-150",
                active ? "bg-surface text-fg" : "text-fg-muted hover:bg-surface/60 hover:text-fg",
              )}
            >
              <span
                className={cn("size-2 shrink-0 rounded-full", PROTOCOL_DOT[t.protocol])}
                title={PROTOCOL_LABEL[t.protocol]}
              />
              <span className="flex-1 truncate">{t.title}</span>
              <SessionStateIcon state={t.state} />
              <button
                type="button"
                aria-label={`Close ${t.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  close(t.id);
                }}
                className="rounded p-0.5 text-fg-subtle opacity-0 group-hover:opacity-100 hover:bg-surface-raised hover:text-fg focus-visible:opacity-100"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <Tooltip label="New session" shortcut="Mod+K">
        <button
          type="button"
          aria-label="New session"
          onClick={() => setPaletteOpen(true)}
          className="mb-1 rounded-md p-1.5 text-fg-subtle hover:bg-surface-raised hover:text-fg"
        >
          <Plus size={14} />
        </button>
      </Tooltip>
    </div>
  );
}
