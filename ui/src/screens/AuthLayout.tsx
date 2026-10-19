import type { ReactNode } from "react";

/** Centered card used by the setup and lock screens. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-bg p-6">
      <div className="w-full max-w-[400px] animate-pop-in">
        <div className="mb-6 flex items-center gap-2">
          <CairnMark />
          <span className="text-sm font-semibold tracking-tight">Cairn</span>
        </div>
        {children}
      </div>
    </div>
  );
}

export function CairnMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="text-accent-text">
      <ellipse cx="12" cy="19" rx="8" ry="3" fill="currentColor" />
      <ellipse cx="12" cy="13.5" rx="6" ry="2.6" fill="currentColor" opacity="0.85" />
      <ellipse cx="12" cy="8.8" rx="4" ry="2.1" fill="currentColor" opacity="0.7" />
      <ellipse cx="12" cy="5" rx="2.3" ry="1.5" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

/** Indeterminate progress bar shown while Argon2id runs (no spinners). */
export function WorkingBar() {
  return (
    <div className="h-0.5 w-full overflow-hidden rounded-full bg-border">
      <div className="h-full w-1/3 animate-shimmer rounded-full bg-accent" />
    </div>
  );
}
