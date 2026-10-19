import type { ReactNode } from "react";
import { isMac } from "@/lib/platform";
import { formatShortcut } from "@/lib/shortcuts";

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border bg-surface px-1 font-mono text-[11px] text-fg-muted">
      {children}
    </kbd>
  );
}

/** Render a shortcut string ("Mod+K") as platform-specific key caps. */
export function Shortcut({ keys }: { keys: string }) {
  const parts = formatShortcut(keys, isMac());
  return (
    <span className="inline-flex gap-0.5" aria-label={parts.join(" ")}>
      {parts.map((k, i) => (
        <Kbd key={i}>{k}</Kbd>
      ))}
    </span>
  );
}
