import { useEffect } from "react";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { Skeleton } from "@/components/ui/Skeleton";
import { CommandError, isTauri, logUiError, onVaultLocked } from "@/lib/ipc";
import { applyTheme, cachedThemePrefs, watchSystemTheme } from "@/lib/theme";
import { LockScreen } from "@/screens/LockScreen";
import { SetupScreen } from "@/screens/SetupScreen";
import { BackupOffer } from "@/backup/BackupOffer";
import { useInventory } from "@/stores/inventory";
import { useMap } from "@/stores/map";
import { useMapUi } from "@/views/map/mapUi";
import { useSnippets } from "@/stores/snippets";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { useVault } from "@/stores/vault";
import { useNotifications } from "@/stores/notifications";
import { ErrorBoundary } from "./ErrorBoundary";
import { Shell } from "./Shell";
import { Toaster } from "./Toaster";

function Loading() {
  return (
    <div className="flex h-full" aria-busy>
      <div className="w-60 bg-bg-subtle p-4">
        <Skeleton className="mb-6 h-5 w-24" />
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="mb-2 h-7" />
        ))}
      </div>
      <div className="flex-1 bg-bg-subtle p-2 pt-10">
        <Skeleton className="h-full rounded-xl" />
      </div>
    </div>
  );
}

function OutsideShell() {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-fg-muted">
      Not running inside the Cairn desktop shell. Start the app with{" "}
      <code className="mx-1 font-mono">npm run tauri dev</code>.
    </div>
  );
}

function Gate() {
  const info = useVault((s) => s.info);
  const refresh = useVault((s) => s.refresh);
  const lockedByBackend = useVault((s) => s.lockedByBackend);

  useEffect(() => {
    refresh().catch((e: unknown) => console.error(CommandError.from(e).message));
    const unlisten = onVaultLocked((reason) => {
      lockedByBackend(reason);
      useSettings.getState().clear();
      useInventory.getState().clear();
      useMap.getState().clear();
      useMapUi.getState().reset();
      useSnippets.getState().clear();
      useUi.setState({ paletteOpen: false, notificationsOpen: false });
    });
    return () => void unlisten.then((fn) => fn());
  }, [refresh, lockedByBackend]);

  useEffect(() => {
    if (info?.status === "locked") {
      useSettings.getState().clear();
      useInventory.getState().clear();
      useMap.getState().clear();
      useMapUi.getState().reset();
      useSnippets.getState().clear();
    }
  }, [info?.status]);

  if (!info) return <Loading />;
  switch (info.status) {
    case "uninitialized":
      return <SetupScreen />;
    case "locked":
      return <LockScreen />;
    case "unlocked":
      return (
        <>
          <Shell />
          <BackupOffer />
        </>
      );
  }
}

/** Surface errors that escape event handlers and promises as notifications. */
function useGlobalErrorReporting() {
  useEffect(() => {
    const report = (err: unknown) => {
      console.error(err);
      if (isTauri())
        void logUiError(err instanceof Error ? `${err.message} ${err.stack ?? ""}` : String(err));
      useNotifications.getState().notifyError(err, "Unexpected error");
    };
    const onError = (e: ErrorEvent) => report(e.error ?? e.message);
    const onRejection = (e: PromiseRejectionEvent) => report(e.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
}

export function App() {
  useGlobalErrorReporting();
  useEffect(() => {
    applyTheme(cachedThemePrefs());
    return watchSystemTheme(() => {
      const s = useSettings.getState().settings;
      return s
        ? {
            theme: s.theme,
            systemDarkTheme: s.systemDarkTheme,
            systemLightTheme: s.systemLightTheme,
          }
        : cachedThemePrefs();
    });
  }, []);

  return (
    <TooltipProvider delayDuration={500}>
      <ErrorBoundary>{isTauri() ? <Gate /> : <OutsideShell />}</ErrorBoundary>
      <Toaster />
    </TooltipProvider>
  );
}
