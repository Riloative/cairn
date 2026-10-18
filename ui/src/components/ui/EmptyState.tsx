import type { ReactNode } from "react";
import { Button } from "./Button";
import { Shortcut } from "./Kbd";

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  /** The single next step. */
  action?: { label: string; onClick: () => void; shortcut?: string };
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center animate-fade-in">
      <div className="mb-1 flex size-12 items-center justify-center rounded-xl bg-surface-raised text-fg-muted">
        {icon}
      </div>
      <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
      <p className="max-w-sm text-fg-muted">{description}</p>
      {action && (
        <Button variant="primary" className="mt-2" onClick={action.onClick}>
          {action.label}
          {action.shortcut && (
            <span className="opacity-80">
              <Shortcut keys={action.shortcut} />
            </span>
          )}
        </Button>
      )}
    </div>
  );
}
