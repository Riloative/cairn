import * as ToastPrimitive from "@radix-ui/react-toast";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import { useNotifications, type NotificationVariant } from "@/stores/notifications";

const ICONS: Record<NotificationVariant, typeof Info> = {
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

/** Errors stay longer so the hint can be read (and copied). */
const DURATION: Record<NotificationVariant, number> = {
  info: 4000,
  success: 4000,
  warning: 8000,
  error: 10000,
};

export function Toaster() {
  const items = useNotifications((s) => s.items);
  const dismiss = useNotifications((s) => s.dismissToast);
  const toasts = items.filter((i) => i.toast).slice(0, 4);

  return (
    <ToastPrimitive.Provider swipeDirection="right">
      {toasts.map((t) => {
        const Icon = ICONS[t.variant];
        return (
          <ToastPrimitive.Root
            key={t.id}
            duration={DURATION[t.variant]}
            onOpenChange={(open) => !open && dismiss(t.id)}
            className="flex gap-3 rounded-lg border border-border bg-surface-raised p-3 shadow-lg animate-slide-in-right"
          >
            <Icon size={16} className={cn("mt-0.5 shrink-0", TONE[t.variant])} />
            <div className="min-w-0 flex-1">
              <ToastPrimitive.Title className="font-medium">{t.title}</ToastPrimitive.Title>
              {t.description && (
                <ToastPrimitive.Description className="mt-0.5 text-fg-muted">
                  {t.description}
                </ToastPrimitive.Description>
              )}
              {t.hint && (
                <p
                  data-selectable
                  className="mt-1.5 rounded-md bg-surface px-2 py-1 font-mono text-xs break-words text-fg-muted"
                >
                  {t.hint}
                </p>
              )}
            </div>
            <ToastPrimitive.Close
              aria-label="Dismiss"
              className="self-start rounded-md px-1 text-fg-subtle hover:text-fg"
            >
              ×
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        );
      })}
      <ToastPrimitive.Viewport className="fixed right-4 bottom-4 z-[60] flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-2 outline-none" />
    </ToastPrimitive.Provider>
  );
}
