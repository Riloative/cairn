import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentProps, ReactNode, RefObject } from "react";
import { cn } from "@/lib/cn";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogOverlay({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        "fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] animate-fade-in",
        className,
      )}
      {...props}
    />
  );
}

interface DialogContentProps extends Omit<ComponentProps<typeof DialogPrimitive.Content>, "title"> {
  title: ReactNode;
  description?: ReactNode;
  /** Hide the close button (e.g. for a blocking confirmation). */
  hideClose?: boolean;
  /** Element to focus when the dialog opens (default: first focusable). */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Called instead of restoring focus to the trigger when the dialog closes. */
  onClosed?: () => void;
}

export function DialogContent({
  className,
  title,
  description,
  hideClose,
  initialFocus,
  onClosed,
  children,
  ...props
}: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          "fixed top-1/2 left-1/2 z-50 w-[min(480px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2",
          // Never taller than the window: long forms (Quick Connect with advanced
          // settings open) scroll instead of running off screen.
          "max-h-[calc(100vh-32px)] overflow-y-auto overscroll-contain",
          "rounded-xl border border-border bg-surface p-6 shadow-lg animate-pop-in focus:outline-none",
          className,
        )}
        onOpenAutoFocus={(e) => {
          if (initialFocus?.current) {
            e.preventDefault();
            initialFocus.current.focus();
          }
        }}
        onCloseAutoFocus={(e) => {
          if (onClosed) {
            e.preventDefault();
            onClosed();
          }
        }}
        {...props}
      >
        <DialogPrimitive.Title className="text-[15px] font-semibold tracking-tight">
          {title}
        </DialogPrimitive.Title>
        {description ? (
          <DialogPrimitive.Description className="mt-1 text-fg-muted">
            {description}
          </DialogPrimitive.Description>
        ) : (
          <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
        )}
        <div className="mt-4">{children}</div>
        {!hideClose && (
          <DialogPrimitive.Close
            aria-label="Close"
            className="absolute top-4 right-4 rounded-md p-1 text-fg-subtle hover:bg-surface-raised hover:text-fg"
          >
            <X size={16} />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mt-6 flex justify-end gap-2", className)} {...props} />;
}
