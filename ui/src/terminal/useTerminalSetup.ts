import { useEffect } from "react";
import { useActions } from "@/lib/actions";
import { isTauri, localContainers, type Settings } from "@/lib/ipc";
import { useNotifications } from "@/stores/notifications";
import { useSettings } from "@/stores/settings";
import { useTerminalPrefs } from "@/stores/terminalPrefs";
import { useUi } from "@/stores/ui";
import { openLocalShell, refreshTerminals } from "./controller";

const KIND_LABEL = { toolbox: "Toolbox", distrobox: "Distrobox", podman: "Podman" } as const;

/**
 * True when a settings change can alter how terminals render. Terminals only read the
 * app theme (the "follow app" palette resolves through `data-theme`, which these three
 * fields decide); every other setting is irrelevant to xterm and must not trigger a
 * restyle of every open terminal.
 */
export function terminalSettingsChanged(next: Settings | null, prev: Settings | null): boolean {
  if (next === prev) return false;
  if (!next || !prev) return true;
  return (
    next.theme !== prev.theme ||
    next.systemDarkTheme !== prev.systemDarkTheme ||
    next.systemLightTheme !== prev.systemLightTheme
  );
}

/** Load terminal preferences, keep open terminals in sync, register container launchers. */
export function useTerminalSetup() {
  const load = useTerminalPrefs((s) => s.load);
  const register = useActions((s) => s.register);
  const notifyError = useNotifications((s) => s.notifyError);

  useEffect(() => {
    load().catch((e: unknown) => notifyError(e, "Could not load terminal preferences"));
  }, [load, notifyError]);

  // Profiles, palettes or the app theme changed: restyle live terminals.
  useEffect(() => {
    const offPrefs = useTerminalPrefs.subscribe((s, prev) => {
      if (s.prefs !== prev.prefs) refreshTerminals();
    });
    const offSettings = useSettings.subscribe((s, prev) => {
      // The theme is applied to <html> synchronously by the store; the palette lookup
      // reads it on the next frame.
      if (terminalSettingsChanged(s.settings, prev.settings))
        requestAnimationFrame(refreshTerminals);
    });
    return () => {
      offPrefs();
      offSettings();
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let off: (() => void) | undefined;
    let alive = true;
    localContainers()
      .then((containers) => {
        if (!alive || containers.length === 0) return;
        off = register(
          containers.map((c) => ({
            id: `container.${c.kind}.${c.name}`,
            title: `${KIND_LABEL[c.kind]}: ${c.name}`,
            group: "Containers",
            keywords: [c.image, "container", c.kind],
            run: () => {
              useUi.getState().setView("sessions");
              void openLocalShell(c.spec, c.name);
            },
          })),
        );
      })
      .catch(() => {
        // Container tools are optional; nothing to report.
      });
    return () => {
      alive = false;
      off?.();
    };
  }, [register]);
}
