import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/** Loading placeholder. Use instead of spinners. */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      aria-hidden
      className={cn("animate-shimmer rounded-md bg-surface-raised", className)}
      {...props}
    />
  );
}
