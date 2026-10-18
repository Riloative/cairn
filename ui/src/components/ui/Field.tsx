import * as LabelPrimitive from "@radix-ui/react-label";
import { useId, type ReactElement, type ReactNode } from "react";
import { cloneElement } from "react";
import { cn } from "@/lib/cn";

interface FieldProps {
  label: ReactNode;
  /** Shown below the control; replaced by `error` when set. */
  description?: ReactNode;
  error?: ReactNode;
  className?: string;
  /** A single form control; it receives `id`, `aria-describedby` and `invalid`. */
  children: ReactElement<Record<string, unknown>>;
}

/** Label + control + description/error, wired for accessibility. */
export function Field({ label, description, error, className, children }: FieldProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const help = error ?? description;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <LabelPrimitive.Root htmlFor={id} className="text-xs font-medium text-fg-muted">
        {label}
      </LabelPrimitive.Root>
      {cloneElement(children, {
        id,
        "aria-describedby": help ? helpId : undefined,
        invalid: error ? true : undefined,
      })}
      {help && (
        <p
          id={helpId}
          role={error ? "alert" : undefined}
          className={cn("text-xs", error ? "text-danger" : "text-fg-subtle")}
        >
          {help}
        </p>
      )}
    </div>
  );
}
