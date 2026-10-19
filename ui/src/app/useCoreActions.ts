import { useEffect } from "react";
import { useDataDialog } from "@/stores/backupUi";
import { useActions, type Action } from "@/lib/actions";
import { auditVerify } from "@/lib/ipc";
import { THEMES } from "@/lib/theme";
import { useNotifications } from "@/stores/notifications";
import { useSessions } from "@/stores/sessions";
import { useSettings } from "@/stores/settings";
import { useInventory } from "@/stores/inventory";
import { useUi } from "@/stores/ui";
import { useVault } from "@/stores/vault";
import { isMac } from "@/lib/platform";
import { useTerminalUi } from "@/stores/terminalUi";
import { copySelection, pasteFromClipboard } from "@/terminal/clipboard";
import { closeTab, openLocalShell, profileIdOf, setTabVendor } from "@/terminal/controller";
import { VENDORS } from "@/terminal/highlight/rulesets";
import { sendBreak, supportsBreak } from "@/terminal/serialControls";
import { useSerial } from "@/stores/serial";
import { useTerminalPrefs } from "@/stores/terminalPrefs";
import { NAV_ITEMS } from "./nav";

/** Build the app-wide actions. Pure so it can be tested without React. */
export function coreActions(): Action[] {
  const ui = () => useUi.getState();
  const sessions = () => useSessions.getState();
  const settings = () => useSettings.getState();
  const notifications = () => useNotifications.getState();
  const hasTabs = () => sessions().tabs.length > 0;
  const terminalActive = () => {
    const id = sessions().activeId;
    const tab = sessions().tabs.find((t) => t.id === id);
    return ui().view === "sessions" && !!tab && tab.protocol !== "rdp";
  };
  const activeTab = () => sessions().tabs.find((t) => t.id === sessions().activeId);
  const connectedProtocol = (p: (proto: string) => boolean) => () => {
    const tab = activeTab();
    return ui().view === "sessions" && !!tab && tab.state === "connected" && p(tab.protocol);
  };
  const mac = isMac();

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
      id: "help.shortcuts",
      title: "Keyboard shortcuts",
      group: "General",
      keywords: ["keys", "help", "cheat sheet", "hotkeys"],
      shortcut: "Mod+/",
      run: () => ui().setShortcutsOpen(true),
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
      id: "data.backup",
      title: "Create backup…",
      group: "Data",
      keywords: ["backup", "export", "encrypted", "save"],
      run: () => useDataDialog.getState().set("backup"),
    },
    {
      id: "data.restore",
      title: "Restore backup…",
      group: "Data",
      keywords: ["backup", "restore", "import"],
      run: () => useDataDialog.getState().set("restore"),
    },
    {
      id: "data.export",
      title: "Export inventory (JSON / CSV)…",
      group: "Data",
      keywords: ["export", "csv", "json", "spreadsheet", "inventory"],
      run: () => useDataDialog.getState().set("export"),
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
      title: "New connection…",
      group: "Sessions",
      keywords: ["ssh", "telnet", "serial", "connect", "host", "address", "jump", "proxy"],
      shortcut: "Mod+N",
      // Opens on the protocol used last.
      run: () => ui().setQuickConnectOpen(true),
    },
    {
      id: "inventory.newDevice",
      title: "New device…",
      group: "Inventory",
      keywords: ["add", "device", "switch", "router", "inventory"],
      run: () => {
        ui().setView("inventory");
        useInventory.getState().setSection("devices");
        useInventory.getState().setSheet({ mode: "new" });
      },
    },
    ...(
      [
        ["locations", "Locations", ["building", "floor", "room", "rack", "site"]],
        ["vlans", "VLANs", ["vlan", "subnet"]],
        ["credentials", "Credential profiles", ["password", "key", "enable", "credentials"]],
        ["fields", "Custom fields", ["custom", "attribute", "fields"]],
      ] as const
    ).map(([section, title, keywords]) => ({
      id: `inventory.section.${section}`,
      title: `Inventory: ${title}`,
      group: "Inventory",
      keywords: [...keywords],
      run: () => {
        ui().setView("inventory");
        useInventory.getState().setSection(section);
      },
    })),
    {
      id: "telnet.connect",
      title: "New Telnet connection…",
      group: "Sessions",
      keywords: ["telnet", "raw", "tcp", "console server", "opengear", "avocent", "reverse"],
      run: () => ui().openConnect("telnet"),
    },
    {
      id: "serial.connect",
      title: "New serial connection…",
      group: "Sessions",
      keywords: ["serial", "console", "usb", "com", "tty", "baud"],
      run: () => ui().openConnect("serial"),
    },
    {
      id: "rdp.connect",
      title: "New RDP connection…",
      group: "Sessions",
      keywords: ["rdp", "remote desktop", "windows", "xrdp", "mstsc"],
      run: () => ui().openConnect("rdp"),
    },
    {
      id: "session.break",
      title: "Send BREAK",
      group: "Terminal",
      keywords: ["break", "rommon", "password recovery", "serial", "telnet"],
      enabled: connectedProtocol(supportsBreak),
      run: () => {
        const id = sessions().activeId;
        if (id) void sendBreak(id);
      },
    },
    {
      id: "serial.send",
      title: "Send file (Xmodem / Ymodem)…",
      group: "Terminal",
      keywords: ["upload", "xmodem", "ymodem", "transfer", "ios", "rommon"],
      enabled: connectedProtocol((p) => p === "serial"),
      run: () => {
        const id = sessions().activeId;
        if (id) useSerial.getState().openDialog(id, "send");
      },
    },
    {
      id: "serial.receive",
      title: "Receive file (Xmodem / Ymodem)…",
      group: "Terminal",
      keywords: ["download", "xmodem", "ymodem", "transfer"],
      enabled: connectedProtocol((p) => p === "serial"),
      run: () => {
        const id = sessions().activeId;
        if (id) useSerial.getState().openDialog(id, "receive");
      },
    },
    {
      id: "tabs.overview",
      title: "Session overview",
      group: "Sessions",
      keywords: ["tabs", "grid", "thumbnails", "expose"],
      shortcut: "Mod+Shift+O",
      enabled: hasTabs,
      run: () => useTerminalUi.getState().setOverviewOpen(true),
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
    {
      id: "terminal.find",
      scope: "terminal",
      title: "Find in terminal",
      group: "Terminal",
      keywords: ["search", "scrollback", "grep"],
      shortcut: "Mod+F",
      enabled: terminalActive,
      run: () => useTerminalUi.getState().setSearchOpen(true),
    },
    {
      id: "terminal.copy",
      scope: "terminal",
      title: "Copy selection",
      group: "Terminal",
      shortcut: mac ? "Mod+C" : "Mod+Shift+C",
      enabled: terminalActive,
      run: () => {
        const id = sessions().activeId;
        if (id) void copySelection(id);
      },
    },
    {
      id: "terminal.paste",
      scope: "terminal",
      title: "Paste",
      group: "Terminal",
      shortcut: mac ? "Mod+V" : "Mod+Shift+V",
      enabled: terminalActive,
      run: () => {
        const id = sessions().activeId;
        if (id) void pasteFromClipboard(id, profileIdOf(id));
      },
    },
    {
      id: "highlight.toggle",
      title: "Toggle keyword highlighting",
      group: "Terminal",
      keywords: ["highlight", "colors", "keywords"],
      run: () => {
        const prefs = useTerminalPrefs.getState();
        prefs
          .update({ highlightEnabled: !prefs.prefs.highlightEnabled })
          .catch((e: unknown) => notifications().notifyError(e, "Could not save"));
      },
    },
    ...VENDORS.map((v) => ({
      id: `highlight.vendor.${v.id}`,
      title: `Highlighting: ${v.label}`,
      group: "Terminal",
      keywords: ["highlight", "vendor", "rules"],
      enabled: () => sessions().activeId !== null,
      run: () => {
        const id = sessions().activeId;
        if (id) setTabVendor(id, v.id);
      },
    })),
  ];
}

export function useCoreActions() {
  const register = useActions((s) => s.register);
  useEffect(() => register(coreActions()), [register]);
}
