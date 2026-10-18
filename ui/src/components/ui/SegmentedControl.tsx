import * as RadioGroup from "@radix-ui/react-radio-group";
import { cn } from "@/lib/cn";

interface SegmentedControlProps<T extends string> {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
}

/**
 * Single-choice segmented control. One tab stop; arrow keys move the selection
 * (Radix RadioGroup roving focus).
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: SegmentedControlProps<T>) {
  return (
    <RadioGroup.Root
      aria-label={label}
      value={value}
      onValueChange={(v) => onChange(v as T)}
      orientation="horizontal"
      loop
      className={cn("flex gap-1 rounded-lg bg-surface-raised p-1", className)}
    >
      {options.map((o) => (
        <RadioGroup.Item
          key={o.value}
          value={o.value}
          className={cn(
            "h-7 flex-1 rounded-md px-2 text-[13px] text-fg-muted transition-colors duration-150 hover:text-fg",
            "data-[state=checked]:bg-surface data-[state=checked]:text-fg data-[state=checked]:shadow-sm",
          )}
        >
          {o.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
