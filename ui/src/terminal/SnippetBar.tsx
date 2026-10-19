import { Braces, Settings2, X } from "lucide-react";
import { useEffect, useMemo } from "react";
import { Tooltip } from "@/components/ui/Tooltip";
import { snippetPath, snippetsFor } from "@/lib/snippets";
import type { SessionTab } from "@/stores/sessions";
import { useSnippets } from "@/stores/snippets";
import { runSnippet } from "./snippetRun";

/** One-click snippets for the active tab (the device's vendor plus generic ones). */
export function SnippetBar({ tab }: { tab: SessionTab }) {
  const visible = useSnippets((s) => s.barVisible);
  const list = useSnippets((s) => s.list);
  const load = useSnippets((s) => s.load);
  const vendor = tab.device?.vendor;
  const shown = useMemo(() => snippetsFor(list ?? [], vendor), [list, vendor]);

  useEffect(() => {
    if (visible && list === null) void load();
  }, [visible, list, load]);

  if (!visible) return null;
  return (
    <div
      role="toolbar"
      aria-label="Snippets"
      className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-surface px-2"
    >
      <Braces size={12} className="mx-1 shrink-0 text-fg-subtle" aria-hidden />
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {list && shown.length === 0 && (
          <span className="px-1 text-xs text-fg-subtle">
            No snippets{vendor ? ` for ${vendor}` : ""} yet.
          </span>
        )}
        {shown.map((s) => (
          <Tooltip key={s.id} label={s.description || s.body.split("\n")[0] || s.name}>
            <button
              type="button"
              onClick={() => runSnippet(s, tab.id)}
              className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs whitespace-nowrap hover:border-accent hover:bg-surface-raised"
            >
              {snippetPath(s)}
              {s.variables.length > 0 && <span className="text-fg-subtle"> …</span>}
            </button>
          </Tooltip>
        ))}
      </div>
      <Tooltip label="Manage snippets">
        <button
          type="button"
          aria-label="Manage snippets"
          onClick={() => useSnippets.getState().openManager()}
          className="rounded p-1 text-fg-subtle hover:bg-surface-raised hover:text-fg"
        >
          <Settings2 size={14} />
        </button>
      </Tooltip>
      <Tooltip label="Hide snippet bar">
        <button
          type="button"
          aria-label="Hide snippet bar"
          onClick={() => useSnippets.getState().setBarVisible(false)}
          className="rounded p-1 text-fg-subtle hover:bg-surface-raised hover:text-fg"
        >
          <X size={14} />
        </button>
      </Tooltip>
    </div>
  );
}
