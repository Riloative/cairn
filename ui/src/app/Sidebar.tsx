import { Bell, Lock, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import { selectUnreadCount, useNotifications } from "@/stores/notifications";
import { useSessions } from "@/stores/sessions";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { useVault } from "@/stores/vault";
import { CairnMark } from "@/screens/AuthLayout";
import { NAV_ITEMS } from "./nav";
import { PROTOCOL_DOT } from "./protocol";
import { SavedList } from "./SavedList";
import { SessionStateIcon } from "./SessionStateIcon";

export function Sidebar() {
  const collapsed = useSettings((s) => s.settings?.sidebarCollapsed ?? false);
  const updateSettings = useSettings((s) => s.update);
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const setNotificationsOpen = useUi((s) => s.setNotificationsOpen);
  const unread = useNotifications(selectUnreadCount);
  const lock = useVault((s) => s.lock);
  const tabs = useSessions((s) => s.tabs);
  const activeId = useSessions((s) => s.activeId);
  const activate = useSessions((s) => s.activate);

  const toggle = () => void updateSettings({ sidebarCollapsed: !collapsed });

  return (
    <aside
      aria-label="Sidebar"
      className={cn(
        "flex shrink-0 flex-col bg-bg-subtle transition-[width] duration-200",
        collapsed ? "w-14" : "w-60",
      )}
    >
      <div className="flex h-12 items-center gap-2 px-4">
        <CairnMark />
        {!collapsed && <span className="text-sm font-semibold tracking-tight">Cairn</span>}
      </div>

      <nav aria-label="Sections" className="flex flex-col gap-0.5 px-2">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = view === item.view;
          const button = (
            <button
              key={item.view}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => setView(item.view)}
              className={cn(
                "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-left transition-colors duration-150",
                active
                  ? "bg-surface-raised text-fg"
                  : "text-fg-muted hover:bg-surface hover:text-fg",
              )}
            >
              <Icon size={16} className="shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </button>
          );
          return (
            <Tooltip key={item.view} label={item.label} shortcut={item.shortcut} side="right">
              {button}
            </Tooltip>
          );
        })}
      </nav>

      {!collapsed && <SavedList />}
      {!collapsed && (
        <section aria-label="Open sessions" className="mt-6 flex min-h-0 flex-1 flex-col px-2">
          <h2 className="px-2.5 pb-1 text-[11px] font-medium tracking-wide text-fg-subtle uppercase">
            Open sessions
          </h2>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tabs.length === 0 ? (
              <p className="px-2.5 py-1 text-xs text-fg-subtle">None yet</p>
            ) : (
              tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    activate(t.id);
                    setView("sessions");
                  }}
                  className={cn(
                    "flex h-7 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px]",
                    t.id === activeId ? "text-fg" : "text-fg-muted hover:bg-surface hover:text-fg",
                  )}
                >
                  <span className={cn("size-2 shrink-0 rounded-full", PROTOCOL_DOT[t.protocol])} />
                  <span className="flex-1 truncate">{t.title}</span>
                  <SessionStateIcon state={t.state} />
                </button>
              ))
            )}
          </div>
        </section>
      )}
      {collapsed && <div className="flex-1" />}

      <div className={cn("flex gap-1 p-2", collapsed ? "flex-col items-center" : "items-center")}>
        <Tooltip label="Notifications" shortcut="Mod+Shift+N" side="right">
          <button
            type="button"
            aria-label={unread ? `Notifications (${unread} unread)` : "Notifications"}
            onClick={() => setNotificationsOpen(true)}
            className="relative rounded-md p-2 text-fg-muted hover:bg-surface hover:text-fg"
          >
            <Bell size={16} />
            {unread > 0 && (
              <span className="absolute top-1 right-1 size-2 rounded-full bg-accent" />
            )}
          </button>
        </Tooltip>
        <Tooltip label="Lock" shortcut="Mod+Shift+L" side="right">
          <button
            type="button"
            aria-label="Lock"
            onClick={() => void lock()}
            className="rounded-md p-2 text-fg-muted hover:bg-surface hover:text-fg"
          >
            <Lock size={16} />
          </button>
        </Tooltip>
        {!collapsed && <div className="flex-1" />}
        <Tooltip
          label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          shortcut="Mod+B"
          side="right"
        >
          <button
            type="button"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={toggle}
            className="rounded-md p-2 text-fg-muted hover:bg-surface hover:text-fg"
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </Tooltip>
      </div>
    </aside>
  );
}
