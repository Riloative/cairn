import { create } from "zustand";
import { CommandError } from "@/lib/ipc";

export type NotificationVariant = "info" | "success" | "warning" | "error";

export interface AppNotification {
  id: number;
  title: string;
  description?: string;
  /** Actionable next step, e.g. a shell command; rendered in monospace. */
  hint?: string;
  variant: NotificationVariant;
  createdAt: number;
  read: boolean;
  /** Whether it is currently shown as a toast. */
  toast: boolean;
  /** One follow-up action offered on the toast (e.g. "Show history"). */
  action?: { label: string; onClick: () => void };
}

export type NotifyInput = Pick<AppNotification, "title"> &
  Partial<Pick<AppNotification, "description" | "hint" | "variant" | "action">>;

interface NotificationState {
  items: AppNotification[];
  notify: (n: NotifyInput) => number;
  notifyError: (err: unknown, title?: string) => number;
  dismissToast: (id: number) => void;
  markAllRead: () => void;
  remove: (id: number) => void;
  clear: () => void;
}

/** History kept in the notification center. */
export const MAX_ITEMS = 100;

let nextId = 1;

export const useNotifications = create<NotificationState>((set, get) => ({
  items: [],
  notify: (n) => {
    const id = nextId++;
    const item: AppNotification = {
      id,
      title: n.title,
      description: n.description,
      hint: n.hint,
      action: n.action,
      variant: n.variant ?? "info",
      createdAt: Date.now(),
      read: false,
      toast: true,
    };
    set({ items: [item, ...get().items].slice(0, MAX_ITEMS) });
    return id;
  },
  notifyError: (err, title) => {
    const e = CommandError.from(err);
    return get().notify({
      title: title ?? e.message,
      description: title ? e.message : undefined,
      hint: e.hint ?? undefined,
      variant: "error",
    });
  },
  dismissToast: (id) =>
    set({ items: get().items.map((i) => (i.id === id ? { ...i, toast: false } : i)) }),
  markAllRead: () => set({ items: get().items.map((i) => ({ ...i, read: true })) }),
  remove: (id) => set({ items: get().items.filter((i) => i.id !== id) }),
  clear: () => set({ items: [] }),
}));

export const selectUnreadCount = (s: NotificationState) => s.items.filter((i) => !i.read).length;
