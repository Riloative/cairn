import { Dialog, DialogContent } from "@/components/ui/Dialog";
import { Shortcut } from "@/components/ui/Kbd";
import { useActions, type Action } from "@/lib/actions";
import { useUi } from "@/stores/ui";
import { focusActiveTerminal } from "@/terminal/controller";

/** Shortcuts that are not actions (they belong to a focused widget). */
const CONTEXT: readonly { group: string; title: string; keys: string }[] = [
  { group: "Remote desktop", title: "Full screen", keys: "F11" },
  { group: "Recordings", title: "Play / pause", keys: "Space" },
  { group: "Lists and menus", title: "Move / choose", keys: "ArrowUp ArrowDown Enter" },
];

type Row = { id: string; title: string; keys: string };

/** Every shortcut, grouped (Mod+/). Reads the action registry, so it is never stale. */
export function ShortcutsSheet() {
  const open = useUi((s) => s.shortcutsOpen);
  const setOpen = useUi((s) => s.setShortcutsOpen);
  const registry = useActions((s) => s.actions);
  if (!open) return null;

  const groups = new Map<string, Row[]>();
  const add = (group: string, row: Row) => groups.set(group, [...(groups.get(group) ?? []), row]);
  const seen = new Set<string>();
  for (const a of registry.values() as Iterable<Action>) {
    if (!a.shortcut) continue;
    // Toggles (e.g. start/stop broadcast) share a shortcut; list it once.
    const key = `${a.group}:${a.shortcut}`;
    if (seen.has(key)) continue;
    seen.add(key);
    add(a.group, { id: a.id, title: a.title, keys: a.shortcut });
  }
  for (const c of CONTEXT)
    add(c.group, { id: `${c.group}:${c.title}`, title: c.title, keys: c.keys });

  return (
    <Dialog open onOpenChange={setOpen}>
      <DialogContent
        title="Keyboard shortcuts"
        description="Everything here is also in the command palette, with or without a shortcut."
        className="w-[min(760px,calc(100vw-32px))]"
        onClosed={focusActiveTerminal}
      >
        {/* Scroll the box, not the columns: a height-capped column box overflows sideways. */}
        <div className="max-h-[60vh] overflow-y-auto">
          <div className="columns-2 gap-8">
            {[...groups].map(([group, rows]) => (
              <section key={group} className="mb-4 break-inside-avoid">
                <h3 className="mb-1 text-xs font-medium text-fg-muted">{group}</h3>
                <ul>
                  {rows.map((r) => (
                    <li key={r.id} className="flex items-center gap-3 py-1 text-[13px]">
                      <span className="flex-1">{r.title}</span>
                      {r.keys.split(" ").map((k) => (
                        <Shortcut key={k} keys={k} />
                      ))}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
