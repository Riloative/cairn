import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Shortcut } from "./Kbd";

const contentClass =
  "z-50 min-w-44 rounded-lg border border-border bg-surface-raised p-1 shadow-md animate-pop-in";
const itemClass =
  "flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-[13px] text-fg outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent-subtle";

interface ItemExtras {
  icon?: ReactNode;
  shortcut?: string;
  destructive?: boolean;
}

function ItemBody({ icon, shortcut, children }: ItemExtras & { children: ReactNode }) {
  return (
    <>
      {icon && <span className="text-fg-muted">{icon}</span>}
      <span className="flex-1">{children}</span>
      {shortcut && <Shortcut keys={shortcut} />}
    </>
  );
}

// ── Dropdown ───────────────────────────────────────────────────────────────────────

export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownMenuTrigger = DropdownPrimitive.Trigger;

export function DropdownMenuContent({
  className,
  ...props
}: ComponentProps<typeof DropdownPrimitive.Content>) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content
        sideOffset={4}
        className={cn(contentClass, className)}
        {...props}
      />
    </DropdownPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  icon,
  shortcut,
  destructive,
  children,
  ...props
}: ComponentProps<typeof DropdownPrimitive.Item> & ItemExtras) {
  return (
    <DropdownPrimitive.Item
      className={cn(itemClass, destructive && "text-danger", className)}
      {...props}
    >
      <ItemBody icon={icon} shortcut={shortcut}>
        {children}
      </ItemBody>
    </DropdownPrimitive.Item>
  );
}

export function DropdownMenuSeparator() {
  return <DropdownPrimitive.Separator className="my-1 h-px bg-border" />;
}

// ── Context menu ───────────────────────────────────────────────────────────────────

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

export function ContextMenuContent({
  className,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content className={cn(contentClass, className)} {...props} />
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuItem({
  className,
  icon,
  shortcut,
  destructive,
  children,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Item> & ItemExtras) {
  return (
    <ContextMenuPrimitive.Item
      className={cn(itemClass, destructive && "text-danger", className)}
      {...props}
    >
      <ItemBody icon={icon} shortcut={shortcut}>
        {children}
      </ItemBody>
    </ContextMenuPrimitive.Item>
  );
}

export function ContextMenuSeparator() {
  return <ContextMenuPrimitive.Separator className="my-1 h-px bg-border" />;
}
