import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export interface InputProps extends ComponentProps<"input"> {
  invalid?: boolean;
}

export function Input({ className, invalid, ...props }: InputProps) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cn(
        "h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg",
        "placeholder:text-fg-subtle transition-colors duration-150",
        "hover:border-border-strong focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
        "focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50",
        invalid && "border-danger focus-visible:border-danger focus-visible:ring-danger/30",
        className,
      )}
      {...props}
    />
  );
}
