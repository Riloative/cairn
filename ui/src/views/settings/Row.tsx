import type { ReactNode } from "react";

/** A settings row: title and description on the left, the control on the right. */
export function Row({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-6 border-b border-border py-4 last:border-0">
      <div className="flex-1">
        <p className="font-medium">{title}</p>
        {description && <p className="text-xs text-fg-muted">{description}</p>}
      </div>
      {children}
    </div>
  );
}
