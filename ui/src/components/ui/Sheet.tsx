import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { DialogOverlay } from "./Dialog";

/** A side sheet (detail panels, notification center). Built on Radix Dialog. */
export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

interface SheetContentProps extends Omit<ComponentProps<typeof DialogPrimitive.Content>, "title"> {
  title: ReactNode;
  description?: ReactNode;
  /** Extra controls rendered in the header, left of the close button. */
  actions?: ReactNode;
}

export function SheetContent({
  className,
  title,
  description,
  actions,
  children,
  ...props
}: SheetContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay className="bg-black/20 backdrop-blur-none" />
      <DialogPrimitive.Content
        className={cn(
          "fixed top-2 right-2 bottom-2 z-50 flex w-[min(420px,calc(100vw-16px))] flex-col",
          "rounded-xl border border-border bg-surface shadow-lg animate-slide-in-right focus:outline-none",
          className,
        )}
        {...props}
      >
        <header className="flex items-start gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <DialogPrimitive.Title className="truncate text-sm font-semibold">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description
              className={description ? "text-xs text-fg-muted" : "sr-only"}
            >
              {description ?? title}
            </DialogPrimitive.Description>
          </div>
          {actions}
          <DialogPrimitive.Close
            aria-label="Close"
            className="rounded-md p-1 text-fg-subtle hover:bg-surface-raised hover:text-fg"
          >
            <X size={16} />
          </DialogPrimitive.Close>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
