import { RadioTower, Search, X } from "lucide-react";
import { useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/Menu";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import { reconnectRdp } from "@/rdp/controller";
import { useBroadcast } from "@/stores/broadcast";
import { useSessions, type SessionTab } from "@/stores/sessions";
import { useUi } from "@/stores/ui";
import {
  canReconnect,
  closeTab as close,
  openLocalShell,
  reconnectTab,
} from "@/terminal/controller";
import { usePrivileged } from "@/terminal/privilege";
import { headerTint, tintOverSurface } from "@/terminal/tint";
import { NewSessionMenu } from "./NewSessionMenu";
import { PROTOCOL_DOT, PROTOCOL_LABEL } from "./protocol";
import { SessionStateIcon } from "./SessionStateIcon";

const DRAG_TYPE = "application/x-cairn-tab";

function reconnect(t: SessionTab) {
  if (t.protocol === "rdp") reconnectRdp(t.id);
  else void reconnectTab(t.id);
}

function closeAll(ids: string[]) {
  for (const id of ids) close(id);
}

/** Index of the tab an arrow/Home/End key moves to from `index`, or null for other keys. */
function keyTarget(key: string, index: number, count: number): number | null {
  switch (key) {
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "ArrowRight":
      return (index + 1) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * Session tabs above the main card. The first tab lines up with the card's left edge
 * and the active one takes the colour of the header right below it, so tab and session
 * read as one piece. Mouse: click, middle-click to close, drag to reorder, right-click
 * for more, "+" for a new session, the magnifier for the command search. Keyboard: the
 * active tab is the one tab stop; arrows, Home and End move to (and show) a neighbour.
 */
export function TabBar() {
  const tabs = useSessions((s) => s.tabs);
  const activeId = useSessions((s) => s.activeId);
  const activate = useSessions((s) => s.activate);
  const move = useSessions((s) => s.move);
  const members = useBroadcast((s) => s.members);
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  const privileged = usePrivileged(activeId);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // In Sessions the active tab continues the header below it; outside Sessions the
  // card is another view, so the tab is selected but not attached.
  const attached = view === "sessions";

  function onDrop(e: DragEvent, index: number) {
    const id = e.dataTransfer.getData(DRAG_TYPE);
    setDropAt(null);
    if (!id) return;
    e.preventDefault();
    const from = tabs.findIndex((t) => t.id === id);
    move(id, from >= 0 && from < index ? index - 1 : index);
  }

  function show(id: string) {
    activate(id);
    setView("sessions");
  }

  function onTabKey(e: KeyboardEvent, index: number) {
    const t = tabs[index];
    if (!t) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      show(t.id);
      return;
    }
    const target = keyTarget(e.key, index, tabs.length);
    if (target === null) return;
    e.preventDefault();
    const next = tabs[target];
    if (!next) return;
    show(next.id);
    listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[target]?.focus();
  }

  return (
    <div className="flex h-10 shrink-0 items-end gap-1 pr-2">
      <div
        ref={listRef}
        role="tablist"
        aria-label="Sessions"
        className="flex min-w-0 items-end gap-1 overflow-x-auto"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DRAG_TYPE)) e.preventDefault();
        }}
      >
        {tabs.map((t, i) => {
          const active = t.id === activeId;
          const others = tabs.filter((x) => x.id !== t.id).map((x) => x.id);
          const right = tabs.slice(i + 1).map((x) => x.id);
          return (
            <ContextMenu key={t.id}>
              <ContextMenuTrigger asChild>
                <div
                  role="tab"
                  tabIndex={active ? 0 : -1}
                  aria-selected={active}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, t.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
                    e.preventDefault();
                    const r = e.currentTarget.getBoundingClientRect();
                    setDropAt(e.clientX < r.left + r.width / 2 ? i : i + 1);
                  }}
                  onDragLeave={() => setDropAt(null)}
                  onDrop={(e) => onDrop(e, dropAt ?? i)}
                  onDragEnd={() => setDropAt(null)}
                  onClick={() => show(t.id)}
                  onKeyDown={(e) => onTabKey(e, i)}
                  onAuxClick={(e) => e.button === 1 && close(t.id)}
                  style={
                    active && attached ? tintOverSurface(headerTint(t, privileged)) : undefined
                  }
                  className={cn(
                    "group relative flex h-8 max-w-56 min-w-32 cursor-default items-center gap-2 rounded-t-lg px-3 text-[13px] transition-colors duration-150",
                    active
                      ? cn("text-fg", !attached && "bg-surface/60")
                      : "text-fg-muted hover:bg-surface/60 hover:text-fg",
                    dropAt === i &&
                      "before:absolute before:inset-y-1 before:-left-0.5 before:w-0.5 before:rounded before:bg-accent",
                    dropAt === i + 1 &&
                      i === tabs.length - 1 &&
                      "after:absolute after:inset-y-1 after:-right-0.5 after:w-0.5 after:rounded after:bg-accent",
                  )}
                >
                  <span
                    className={cn("size-2 shrink-0 rounded-full", PROTOCOL_DOT[t.protocol])}
                    title={PROTOCOL_LABEL[t.protocol]}
                  />
                  <span className="flex-1 truncate">{t.title}</span>
                  {members.includes(t.id) && (
                    <RadioTower
                      size={12}
                      aria-label="Broadcasting"
                      className="shrink-0 text-warning"
                    />
                  )}
                  <SessionStateIcon state={t.state} />
                  {/* Not a <button>: interactive content may not nest inside a tab. */}
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={`Close ${t.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      close(t.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      e.stopPropagation();
                      close(t.id);
                    }}
                    className={cn(
                      "rounded p-0.5 text-fg-subtle hover:bg-surface-raised hover:text-fg focus-visible:opacity-100",
                      // Always visible on the active tab, on hover elsewhere.
                      active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                    )}
                  >
                    <X size={12} />
                  </span>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                {(t.protocol === "rdp" ? t.state !== "connected" : canReconnect(t.id)) && (
                  <>
                    <ContextMenuItem onSelect={() => reconnect(t)}>Reconnect</ContextMenuItem>
                    <ContextMenuSeparator />
                  </>
                )}
                <ContextMenuItem shortcut="Mod+W" onSelect={() => close(t.id)}>
                  Close
                </ContextMenuItem>
                <ContextMenuItem disabled={others.length === 0} onSelect={() => closeAll(others)}>
                  Close other tabs
                </ContextMenuItem>
                <ContextMenuItem disabled={right.length === 0} onSelect={() => closeAll(right)}>
                  Close tabs to the right
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
      <NewSessionMenu />
      {/* Double-clicking the empty bar opens a local shell, as in most terminals. */}
      <div
        aria-hidden
        className="h-full min-w-4 flex-1"
        onDoubleClick={() => {
          setView("sessions");
          void openLocalShell();
        }}
      />
      <Tooltip label="Search commands, devices and sessions" shortcut="Mod+K">
        <button
          type="button"
          aria-label="Search"
          onClick={() => setPaletteOpen(true)}
          className="mb-1 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-fg-subtle hover:bg-surface-raised hover:text-fg"
        >
          <Search size={14} />
          <span>Search</span>
        </button>
      </Tooltip>
    </div>
  );
}
