import { useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/cn";
import { useSessions, type SessionTab } from "@/stores/sessions";
import { useTerminalUi } from "@/stores/terminalUi";
import { useUi } from "@/stores/ui";
import { PROTOCOL_DOT, STATE_LABEL } from "@/app/protocol";
import { SessionStateIcon } from "@/app/SessionStateIcon";
import { focusActiveTerminal } from "./controller";
import { getTerminal } from "./registry";

const THUMB_ROWS = 14;

/** Thumbnail colours when a tab has no terminal yet (or its palette is unset). */
const FALLBACK = { bg: "var(--bg)", fg: "var(--fg)" };

/** Plain-text snapshot of the bottom of a terminal's viewport (never rendered as HTML). */
function snapshot(tabId: string): { lines: string[]; bg: string; fg: string } {
  const h = getTerminal(tabId);
  if (!h) return { lines: [], ...FALLBACK };
  const buf = h.term.buffer.active;
  // Show the lines ending at the cursor (the most recent output), not the empty rows below.
  const end = buf.baseY + buf.cursorY + 1;
  const lines: string[] = [];
  for (let y = Math.max(0, end - THUMB_ROWS); y < end; y++) {
    lines.push(buf.getLine(y)?.translateToString(true) ?? "");
  }
  const theme = h.term.options.theme ?? {};
  return {
    lines,
    // Palette colours may carry alpha (#RRGGBBAA); the thumbnail wants them opaque.
    bg: theme.background ? theme.background.slice(0, 7) : FALLBACK.bg,
    fg: theme.foreground ?? FALLBACK.fg,
  };
}

function Thumb({ tab, onPick }: { tab: SessionTab; onPick: () => void }) {
  const [snap, setSnap] = useState(() => snapshot(tab.id));
  useEffect(() => {
    const t = setInterval(() => setSnap(snapshot(tab.id)), 500);
    return () => clearInterval(t);
  }, [tab.id]);
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex flex-col overflow-hidden rounded-lg border border-border bg-surface text-left shadow-sm transition-transform duration-150 hover:-translate-y-0.5 hover:border-accent focus-visible:border-accent"
    >
      {/* Colors come from the terminal palette (data), text is plain. */}
      <pre
        aria-hidden
        className="h-36 overflow-hidden p-2 font-mono text-[7px] leading-[9px]"
        style={{ background: snap.bg, color: snap.fg }}
      >
        {snap.lines.join("\n")}
      </pre>
      <div className="flex items-center gap-2 px-3 py-2 text-[13px]">
        <span className={cn("size-2 rounded-full", PROTOCOL_DOT[tab.protocol])} />
        <span className="flex-1 truncate">{tab.title}</span>
        <SessionStateIcon state={tab.state} />
        <span className="sr-only">{STATE_LABEL[tab.state]}</span>
      </div>
    </button>
  );
}

/** Grid of live thumbnails of every session (Mod+Shift+O). */
export function TabOverview() {
  const open = useTerminalUi((s) => s.overviewOpen);
  const setOpen = useTerminalUi((s) => s.setOverviewOpen);
  const tabs = useSessions((s) => s.tabs);
  const activate = useSessions((s) => s.activate);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-bg/95 backdrop-blur-sm animate-fade-in" />
        <DialogPrimitive.Content
          className="fixed inset-6 z-50 overflow-y-auto animate-pop-in focus:outline-none"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            focusActiveTerminal();
          }}
        >
          <DialogPrimitive.Title className="mb-4 text-[15px] font-semibold">
            All sessions
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Pick a session to switch to it.
          </DialogPrimitive.Description>
          {tabs.length === 0 ? (
            <p className="text-fg-muted">No open sessions.</p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
              {tabs.map((t) => (
                <Thumb
                  key={t.id}
                  tab={t}
                  onPick={() => {
                    activate(t.id);
                    useUi.getState().setView("sessions");
                    setOpen(false);
                  }}
                />
              ))}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
