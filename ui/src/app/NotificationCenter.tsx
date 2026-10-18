import { AlertTriangle, BellOff, CheckCircle2, Info, XCircle } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Sheet, SheetContent } from "@/components/ui/Sheet";
import { cn } from "@/lib/cn";
import { useNotifications, type NotificationVariant } from "@/stores/notifications";
import { useUi } from "@/stores/ui";

const ICON: Record<NotificationVariant, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};
const TONE: Record<NotificationVariant, string> = {
  info: "text-accent",
  success: "text-success",
  warning: "text-warning",
  error: "text-danger",
};

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

export function NotificationCenter() {
  const open = useUi((s) => s.notificationsOpen);
  const setOpen = useUi((s) => s.setNotificationsOpen);
  const items = useNotifications((s) => s.items);
  const markAllRead = useNotifications((s) => s.markAllRead);
  const clear = useNotifications((s) => s.clear);
  const remove = useNotifications((s) => s.remove);

  // Opening the center counts as reading everything in it.
  useEffect(() => {
    if (open) markAllRead();
  }, [open, items.length, markAllRead]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        title="Notifications"
        actions={
          items.length > 0 && (
            <Button variant="ghost" size="sm" onClick={clear}>
              Clear all
            </Button>
          )
        }
      >
        {items.length === 0 ? (
          <EmptyState
            icon={<BellOff size={20} />}
            title="You're all caught up"
            description="Connection events, errors and finished tasks will appear here."
          />
        ) : (
          <ul className="flex flex-col p-2">
            {items.map((n) => {
              const Icon = ICON[n.variant];
              return (
                <li
                  key={n.id}
                  className="group flex gap-3 rounded-lg px-3 py-2.5 hover:bg-surface-raised"
                >
                  <Icon size={16} className={cn("mt-0.5 shrink-0", TONE[n.variant])} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <p className="flex-1 font-medium">{n.title}</p>
                      <time className="text-[11px] text-fg-subtle">
                        {timeFormat.format(n.createdAt)}
                      </time>
                    </div>
                    {n.description && <p className="text-fg-muted">{n.description}</p>}
                    {n.hint && (
                      <p
                        data-selectable
                        className="mt-1 rounded-md bg-surface px-2 py-1 font-mono text-xs break-words text-fg-muted"
                      >
                        {n.hint}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    aria-label="Remove notification"
                    onClick={() => remove(n.id)}
                    className="self-start px-1 text-fg-subtle opacity-0 group-hover:opacity-100 hover:text-fg focus-visible:opacity-100"
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </SheetContent>
    </Sheet>
  );
}
