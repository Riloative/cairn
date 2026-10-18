import { Command } from "cmdk";
import { Search } from "lucide-react";
import { useMemo } from "react";
import { Shortcut } from "@/components/ui/Kbd";
import { availableActions, useActions, type Action } from "@/lib/actions";
import { useUi } from "@/stores/ui";
import { focusActiveTerminal } from "@/terminal/controller";

function groupBy(actions: Action[]): [string, Action[]][] {
  const groups = new Map<string, Action[]>();
  for (const a of actions) groups.set(a.group, [...(groups.get(a.group) ?? []), a]);
  return [...groups.entries()];
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const registry = useActions((s) => s.actions);
  // Re-evaluate `enabled` each time the palette opens.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const groups = useMemo(() => groupBy(availableActions(registry)), [registry, open]);

  const run = (a: Action) => {
    setOpen(false);
    void a.run();
    // Actions that open dialogs move focus themselves; otherwise type into the terminal.
    focusActiveTerminal();
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) focusActiveTerminal();
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      loop
      overlayClassName="fixed inset-0 z-40 bg-black/30 animate-fade-in"
      contentClassName="fixed top-[14vh] left-1/2 z-50 w-[min(600px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-lg animate-pop-in focus:outline-none"
    >
      <div className="flex items-center gap-2 border-b border-border px-4">
        <Search size={16} className="text-fg-subtle" />
        <Command.Input
          placeholder="Type a command or search…"
          className="h-12 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
        />
      </div>
      <Command.List className="max-h-[min(420px,60vh)] overflow-y-auto p-2">
        <Command.Empty className="px-3 py-8 text-center text-fg-muted">
          No matching commands.
        </Command.Empty>
        {groups.map(([group, actions]) => (
          <Command.Group
            key={group}
            heading={group}
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-fg-subtle [&_[cmdk-group-heading]]:uppercase"
          >
            {actions.map((a) => (
              <Command.Item
                key={a.id}
                value={`${a.group} ${a.title}`}
                keywords={a.keywords}
                onSelect={() => run(a)}
                className="flex h-9 cursor-default items-center gap-2 rounded-md px-2 text-[13px] text-fg data-[selected=true]:bg-accent-subtle"
              >
                <span className="flex-1 truncate">{a.title}</span>
                {a.shortcut && <Shortcut keys={a.shortcut} />}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  );
}
