import { useEffect } from "react";
import { useActions, type Action } from "@/lib/actions";
import { auditVerify } from "@/lib/ipc";
import { THEMES } from "@/lib/theme";
import { useNotifications } from "@/stores/notifications";
import { useSessions } from "@/stores/sessions";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { useVault } from "@/stores/vault";
import { closeTab, openLocalShell } from "@/terminal/controller";
import { NAV_ITEMS } from "./nav";

/** Build the app-wide actions. Pure so it can be tested without React. */
export function coreActions(): Action[] {
  const ui = () => useUi.getState();
  const sessions = () => useSessions.getState();
  const settings = () => useSettings.getState();
  const notifications = () => useNotifications.getState();
  const hasTabs = () => sessions().tabs.length > 0;

  const navigation: Action[] = NAV_ITEMS.map((item) => ({
    id: `view.${item.view}`,
    title: `Go to ${item.label}`,
    group: "Navigation",
    shortcut: item.shortcut,
    run: () => ui().setView(item.view),
  }));

  const themes: Action[] = [
    { id: "system", label: "Follow system" },
    ...THEMES.map((t) => ({ id: t.id, label: t.label })),
  ].map((t) => ({
    id: `theme.${t.id}`,
    title: `Theme: ${t.label}`,
    group: "Appearance",
    keywords: ["theme", "dark", "light", "color"],
    run: () =>
      settings()
        .update({ theme: t.id as never })
        .catch((e: unknown) => notifications().notifyError(e, "Could not change theme")),
  }));

  return [
    {
      id: "palette.open",
      title: "Command palette",
      group: "General",
      shortcut: "Mod+K",
      run: () => ui().setPaletteOpen(!ui().paletteOpen),
    },
    ...navigation,
    {
      id: "sidebar.toggle",
      title: "Toggle sidebar",
      group: "General",
      shortcut: "Mod+B",
      run: () => {
        const collapsed = settings().settings?.sidebarCollapsed ?? false;
        void settings().update({ sidebarCollapsed: !collapsed });
      },
    },
    {
      id: "notifications.open",
      title: "Show notifications",
      group: "General",
      shortcut: "Mod+Shift+N",
      run: () => ui().setNotificationsOpen(true),
    },
    {
      id: "vault.lock",
      title: "Lock Cairn",
      group: "Security",
      keywords: ["lock", "secure"],
      shortcut: "Mod+Shift+L",
      run: () =>
        useVault
          .getState()
          .lock()
          .catch((e: unknown) => notifications().notifyError(e, "Could not lock")),
    },
    {
      id: "audit.verify",
      title: "Verify audit log integrity",
      group: "Security",
      keywords: ["audit", "hash", "tamper"],
      run: async () => {
        try {
          const r = await auditVerify();
          notifications().notify(
            r.ok
              ? {
                  title: "Audit log intact",
                  description: `${r.entries} entries verified.`,
                  variant: "success",
                }
              : {
                  title: "Audit log tampering detected",
                  description: `The hash chain breaks at entry #${r.firstBadSeq}.`,
                  variant: "error",
                },
          );
        } catch (e) {
          notifications().notifyError(e, "Integrity check failed");
        }
      },
    },
    {
      id: "terminal.newLocal",
      title: "New local shell",
      group: "Sessions",
      keywords: ["terminal", "shell", "bash", "zsh", "local"],
      shortcut: "Mod+T",
      run: () => {
        ui().setView("sessions");
        void openLocalShell();
      },
    },
    {
      id: "ssh.quickConnect",
      title: "New SSH connection…",
      group: "Sessions",
      keywords: ["ssh", "connect", "host", "device", "jump", "proxy"],
      shortcut: "Mod+N",
      run: () => ui().setQuickConnectOpen(true),
    },
    {
      id: "tabs.next",
      title: "Next tab",
      group: "Sessions",
      shortcut: "Ctrl+Tab",
      enabled: hasTabs,
      run: () => sessions().activateRelative(1),
    },
    {
      id: "tabs.previous",
      title: "Previous tab",
      group: "Sessions",
      shortcut: "Ctrl+Shift+Tab",
      enabled: hasTabs,
      run: () => sessions().activateRelative(-1),
    },
    {
      id: "tabs.close",
      title: "Close tab",
      group: "Sessions",
      shortcut: "Mod+W",
      enabled: () => sessions().activeId !== null,
      run: () => {
        const id = sessions().activeId;
        if (id) closeTab(id);
      },
    },
    ...themes,
  ];
}

export function useCoreActions() {
  const register = useActions((s) => s.register);
  useEffect(() => register(coreActions()), [register]);
}
