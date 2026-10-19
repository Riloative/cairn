import { TerminalSquare } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { GettingStarted } from "@/app/GettingStarted";
import { useSessions } from "@/stores/sessions";
import { backendSessionId, openLocalShell } from "@/terminal/controller";
import { RdpPane } from "@/rdp/RdpPane";
import { FilePanel } from "@/terminal/FilePanel";
import { TerminalHeader } from "@/terminal/TerminalHeader";
import { TerminalPane } from "@/terminal/TerminalPane";
import { usePrivileged } from "@/terminal/privilege";
import { ReconnectOverlay } from "@/terminal/ReconnectOverlay";
import { SearchBar } from "@/terminal/SearchBar";
import { SnippetBar } from "@/terminal/SnippetBar";
import { BroadcastBanner } from "@/views/broadcast/BroadcastBanner";

export function SessionsView() {
  const tabs = useSessions((s) => s.tabs);
  const activeId = useSessions((s) => s.activeId);
  const active = tabs.find((t) => t.id === activeId);
  const privileged = usePrivileged(active?.id ?? null);
  const sessionId = active ? backendSessionId(active.id) : undefined;

  if (!active) {
    return (
      <div className="flex h-full flex-col justify-center overflow-y-auto p-6">
        <EmptyState
          className="h-auto"
          icon={<TerminalSquare size={20} />}
          title="No open sessions"
          description="Start a local shell, or connect to a device over SSH, Telnet, a serial cable or RDP (Ctrl/⌘ N)."
          action={{
            label: "New local shell",
            onClick: () => void openLocalShell(),
            shortcut: "Mod+T",
          }}
        />
        <GettingStarted />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <BroadcastBanner />
      <TerminalHeader tab={active} privileged={privileged} />
      <SnippetBar tab={active} />
      <div className="flex min-h-0 flex-1">
        <div
          data-session-area
          className="relative min-h-0 flex-1"
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {tabs.map((t) =>
            t.protocol === "rdp" ? (
              <RdpPane key={t.id} tab={t} active={t.id === activeId} />
            ) : (
              <TerminalPane key={t.id} tabId={t.id} active={t.id === activeId} />
            ),
          )}
          {active.protocol !== "rdp" && (
            <>
              <ReconnectOverlay tab={active} />
              <SearchBar key={active.id} tabId={active.id} />
            </>
          )}
        </div>
        {active.protocol === "ssh" && sessionId && <FilePanel tab={active} sessionId={sessionId} />}
      </div>
    </div>
  );
}
