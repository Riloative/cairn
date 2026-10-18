import { useEffect } from "react";
import { AuditView } from "@/views/AuditView";
import { SessionsView } from "@/views/SessionsView";
import { SettingsView } from "@/views/settings/SettingsView";
import { MapView } from "@/views/map/MapView";
import { useNotifications } from "@/stores/notifications";
import { useSettings } from "@/stores/settings";
import { useUi, type View } from "@/stores/ui";
import { CommandPalette } from "./CommandPalette";
import { NotificationCenter } from "./NotificationCenter";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import { useActivityPing } from "./useActivityPing";
import { useCoreActions } from "./useCoreActions";
import { useDeviceActions } from "./useDeviceActions";
import { useInventory } from "@/stores/inventory";
import { useGlobalShortcuts } from "./useGlobalShortcuts";
import { useTerminalSetup } from "@/terminal/useTerminalSetup";
import { QuickConnectDialog } from "@/ssh/QuickConnectDialog";
import { TransferDialog } from "@/terminal/TransferDialog";
import { SessionPrompts } from "@/ssh/SessionPrompts";
import { PasteConfirmDialog } from "@/terminal/PasteConfirmDialog";
import { TabOverview } from "@/terminal/TabOverview";
import { InventoryView } from "@/views/inventory/InventoryView";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

function ActiveView({ view }: { view: View }) {
  switch (view) {
    case "sessions":
      return <SessionsView />;
    case "inventory":
      return <InventoryView />;
    case "map":
      return <MapView />;
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
  useDeviceActions();
  useGlobalShortcuts();
  useActivityPing();
  useTerminalSetup();

  useEffect(() => {
    load().catch((e: unknown) => notifyError(e, "Could not load settings"));
    // Devices feed the command palette even before the inventory view is opened.
    void useInventory.getState().load();
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
      <PasteConfirmDialog />
      <TabOverview />
      <TransferDialog />
      <ConfirmDialog />
    </div>
  );
}
