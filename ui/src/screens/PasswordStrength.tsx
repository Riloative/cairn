import { cn } from "@/lib/cn";
import type { StrengthResult } from "./strength";

const LABELS = ["Very weak", "Weak", "Fair", "Strong", "Very strong"] as const;
const COLORS = ["bg-danger", "bg-danger", "bg-warning", "bg-success", "bg-success"] as const;

export function PasswordStrengthMeter({ result }: { result: StrengthResult | null }) {
  const score = result?.score ?? -1;
  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      <div
        className="flex gap-1"
        role="meter"
        aria-label="Password strength"
        aria-valuemin={0}
        aria-valuemax={4}
        aria-valuenow={Math.max(score, 0)}
      >
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className={cn(
              "h-1 flex-1 rounded-full bg-border transition-colors duration-200",
              i <= score && COLORS[score as 0],
            )}
          />
        ))}
      </div>
      {result && (
        <p className="text-xs text-fg-muted">
          <span className="font-medium text-fg">{LABELS[result.score]}</span>
          {" · "}
          {result.warning || result.suggestions[0] || `Offline cracking time: ${result.crackTime}`}
        </p>
      )}
    </div>
  );
}
