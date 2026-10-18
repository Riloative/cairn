import { useEffect } from "react";
import { useAppInfo } from "@/stores/appInfo";

const SECTIONS = ["Sessions", "Inventory", "Map", "Audit", "Settings"] as const;

/**
 * M0 placeholder shell: proves the design tokens, fonts, Tailwind and the IPC bridge are
 * wired. The real shell (sidebar, tabs, palette) arrives in M1.
 */
export function App() {
  const { info, error, load } = useAppInfo();

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full">
      <nav
        aria-label="Sections"
        className="flex w-56 shrink-0 flex-col gap-1 bg-bg-subtle p-2 pt-4 text-fg-muted"
      >
        <div className="px-2 pb-4 text-sm font-semibold tracking-tight text-fg">Cairn</div>
        {SECTIONS.map((s) => (
          <button
            key={s}
            type="button"
            className="h-8 rounded-md px-2 text-left hover:bg-surface-raised hover:text-fg"
          >
            {s}
          </button>
        ))}
      </nav>
      <main className="flex flex-1 flex-col items-center justify-center gap-4 bg-bg">
        <h1 className="text-xl font-semibold tracking-tight">Welcome to Cairn</h1>
        <p className="max-w-sm text-center text-fg-muted">
          This is the scaffolding build. Sessions, inventory and the map arrive in the next
          milestones.
        </p>
        <p className="font-mono text-xs text-fg-subtle" data-testid="app-version">
          {info ? `v${info.version} · ${info.os}/${info.arch}` : (error ?? "")}
        </p>
      </main>
    </div>
  );
}
