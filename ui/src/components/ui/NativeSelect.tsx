import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

interface NativeSelectProps extends ComponentProps<"select"> {
  /** Set by `Field` when it shows an error. */
  invalid?: boolean;
}

/** Styled native `<select>`: keyboard and screen-reader behavior come from the platform. */
export function NativeSelect({ className, invalid, ...props }: NativeSelectProps) {
  return (
    <select
      aria-invalid={invalid || undefined}
      className={cn(
        "h-8 min-w-0 rounded-md border border-border bg-surface px-2 text-[13px] disabled:opacity-50",
        invalid && "border-danger",
        className,
      )}
      {...props}
    />
  );
}
