import { MoreHorizontal } from "lucide-react";
import { openSaved, targetOf } from "@/connect/saved";
import type { SavedConnection } from "@/lib/ipc";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/Menu";
import { confirmAction } from "@/stores/confirm";
import { useSavedConnections } from "@/stores/savedConnections";
import { useUi } from "@/stores/ui";
import { cn } from "@/lib/cn";
import { PROTOCOL_DOT } from "./protocol";

async function remove(s: SavedConnection) {
  const ok = await confirmAction({
    title: `Delete ${s.name}?`,
    description:
      "Only the saved connection is removed; open sessions and credential profiles stay.",
    confirmLabel: "Delete",
    destructive: true,
  });
  if (ok) await useSavedConnections.getState().remove(s);
}

/** Saved connections in the sidebar: click to connect, menu to edit or delete. */
export function SavedList() {
  const list = useSavedConnections((s) => s.list);
  const editSaved = useUi((s) => s.editSaved);
  if (!list || list.length === 0) return null;
  return (
    <section aria-label="Saved connections" className="mt-6 flex max-h-[40%] min-h-0 flex-col px-2">
      <h2 className="px-2.5 pb-1 text-[11px] font-medium tracking-wide text-fg-subtle uppercase">
        Saved
      </h2>
      <ul className="min-h-0 overflow-y-auto">
        {list.map((s) => (
          <li key={s.id} className="group relative">
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  title={`${s.protocol.toUpperCase()} · ${targetOf(s)}`}
                  onClick={() => openSaved(s)}
                  className="flex h-7 w-full items-center gap-2 rounded-md pr-8 pl-2.5 text-left text-[13px] text-fg-muted hover:bg-surface hover:text-fg"
                >
                  <span className={cn("size-2 shrink-0 rounded-full", PROTOCOL_DOT[s.protocol])} />
                  <span className="flex-1 truncate">{s.name}</span>
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => openSaved(s)}>Connect</ContextMenuItem>
                <ContextMenuItem onSelect={() => editSaved(s)}>Edit…</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem destructive onSelect={() => void remove(s)}>
                  Delete…
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Actions for ${s.name}`}
                  className="absolute top-1 right-1 rounded p-0.5 text-fg-subtle opacity-0 group-hover:opacity-100 hover:text-fg focus-visible:opacity-100"
                >
                  <MoreHorizontal size={14} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="right">
                <DropdownMenuItem onSelect={() => editSaved(s)}>Edit…</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={() => void remove(s)}>
                  Delete…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
      </ul>
    </section>
  );
}
