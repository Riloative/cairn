import { Map as MapIcon, Server } from "lucide-react";
import { useEffect } from "react";
import { AuditView } from "@/views/AuditView";
import { SessionsView } from "@/views/SessionsView";
import { SettingsView } from "@/views/settings/SettingsView";
import { UpcomingView } from "@/views/UpcomingView";
import { useNotifications } from "@/stores/notifications";
import { useSettings } from "@/stores/settings";
import { useUi, type View } from "@/stores/ui";
import { CommandPalette } from "./CommandPalette";
import { NotificationCenter } from "./NotificationCenter";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import { useActivityPing } from "./useActivityPing";
import { useCoreActions } from "./useCoreActions";
import { useGlobalShortcuts } from "./useGlobalShortcuts";
import { useTerminalSetup } from "@/terminal/useTerminalSetup";
import { QuickConnectDialog } from "@/ssh/QuickConnectDialog";
import { SessionPrompts } from "@/ssh/SessionPrompts";

function ActiveView({ view }: { view: View }) {
  switch (view) {
    case "sessions":
      return <SessionsView />;
    case "inventory":
      return (
        <UpcomingView
          icon={<Server size={20} />}
          title="Inventory"
          description="Sites, racks, devices, interfaces and VLANs arrive in milestone 4."
        />
      );
    case "map":
      return (
        <UpcomingView
          icon={<MapIcon size={20} />}
          title="Network map"
          description="Campus, building, floor and rack views arrive in milestone 5."
        />
      );
    case "audit":
      return <AuditView />;
    case "settings":
      return <SettingsView />;
  }
}

/** The unlocked app: sidebar, session tabs and the active view. */
export function Shell() {
  const view = useUi((s) => s.view);
  const load = useSettings((s) => s.load);
  const notifyError = useNotifications((s) => s.notifyError);

  useCoreActions();
  useGlobalShortcuts();
  useActivityPing();
  useTerminalSetup();

  useEffect(() => {
    load().catch((e: unknown) => notifyError(e, "Could not load settings"));
  }, [load, notifyError]);

  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col bg-bg-subtle">
        <TabBar />
        <main
          aria-label={view}
          className="mr-2 mb-2 min-h-0 flex-1 overflow-hidden rounded-xl bg-surface shadow-sm"
        >
          <ActiveView view={view} />
        </main>
      </div>
      <CommandPalette />
      <NotificationCenter />
      <QuickConnectDialog />
      <SessionPrompts />
    </div>
  );
}
