import { lazy, Suspense, useEffect } from "react";
import { Skeleton } from "@/components/ui/Skeleton";
import { SessionsView } from "@/views/SessionsView";
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
import { useToolActions } from "./useToolActions";
import { BroadcastDialog } from "@/views/broadcast/BroadcastDialog";
import { SnippetsManager } from "@/views/snippets/SnippetsManager";
import { SnippetVariablesDialog } from "@/views/snippets/SnippetVariablesDialog";
import { useInventory } from "@/stores/inventory";
import { useGlobalShortcuts } from "./useGlobalShortcuts";
import { useTerminalSetup } from "@/terminal/useTerminalSetup";
import { QuickConnectDialog } from "@/ssh/QuickConnectDialog";
import { TransferDialog } from "@/terminal/TransferDialog";
import { SessionPrompts } from "@/ssh/SessionPrompts";
import { PasteConfirmDialog } from "@/terminal/PasteConfirmDialog";
import { TabOverview } from "@/terminal/TabOverview";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

// Views other than Sessions load on first use, so startup only parses what the first
// screen needs (the map alone brings React Flow and ELK).
const InventoryView = lazy(() =>
  import("@/views/inventory/InventoryView").then((m) => ({ default: m.InventoryView })),
);
const MapView = lazy(() => import("@/views/map/MapView").then((m) => ({ default: m.MapView })));
const AuditView = lazy(() => import("@/views/AuditView").then((m) => ({ default: m.AuditView })));
const ToolsView = lazy(() =>
  import("@/views/tools/ToolsView").then((m) => ({ default: m.ToolsView })),
);
const SettingsView = lazy(() =>
  import("@/views/settings/SettingsView").then((m) => ({ default: m.SettingsView })),
);

function ViewSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-6" aria-busy="true">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-10" />
      <Skeleton className="h-64" />
    </div>
  );
}

function ActiveView({ view }: { view: View }) {
  return (
    <Suspense fallback={<ViewSkeleton />}>
      <ViewFor view={view} />
    </Suspense>
  );
}

function ViewFor({ view }: { view: View }) {
  switch (view) {
    case "sessions":
      return <SessionsView />;
    case "inventory":
      return <InventoryView />;
    case "map":
      return <MapView />;
    case "audit":
      return <AuditView />;
    case "tools":
      return <ToolsView />;
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
  useToolActions();
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
      <SnippetsManager />
      <SnippetVariablesDialog />
      <BroadcastDialog />
      <ConfirmDialog />
    </div>
  );
}
