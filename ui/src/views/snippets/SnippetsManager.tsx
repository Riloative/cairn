import { Braces, FolderClosed, Play, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { NativeSelect } from "@/components/ui/NativeSelect";
import { Sheet, SheetContent } from "@/components/ui/Sheet";
import { cn } from "@/lib/cn";
import type { Snippet } from "@/lib/ipc";
import { groupByFolder, snippetPath } from "@/lib/snippets";
import { confirmAction } from "@/stores/confirm";
import { useInventory } from "@/stores/inventory";
import { useSnippets } from "@/stores/snippets";
import { runSnippet } from "@/terminal/snippetRun";

const BLANK: Snippet = {
  id: 0,
  name: "",
  folder: "",
  vendor: "",
  body: "",
  description: "",
  variables: [],
};

/** Mirrors the Rust check so typos show before saving. */
function bodyError(body: string): string | undefined {
  if (!body.trim()) return "Enter the command(s) to insert.";
  let rest = body;
  for (;;) {
    const start = rest.indexOf("{{");
    if (start < 0) return undefined;
    const end = rest.indexOf("}}", start + 2);
    if (end < 0) return 'A variable is missing its closing "}}".';
    const name =
      rest
        .slice(start + 2, end)
        .split(":")[0]
        ?.trim() ?? "";
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name))
      return `"{{${rest.slice(start + 2, end)}}}" is not a valid variable. Use {{name}} or {{name:default}}.`;
    rest = rest.slice(end + 2);
  }
}

function Editor({ initial, onSaved }: { initial: Snippet; onSaved: (s: Snippet) => void }) {
  const save = useSnippets((s) => s.save);
  const remove = useSnippets((s) => s.remove);
  const vendors = useInventory((s) => s.snapshot?.vendors) ?? [];
  const [s, setS] = useState(initial);
  const [touched, setTouched] = useState(false);
  const set = <K extends keyof Snippet>(k: K, v: Snippet[K]) => setS({ ...s, [k]: v });
  const nameError = s.name.trim() ? undefined : "Enter a name.";
  const bodyErr = bodyError(s.body);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (nameError || bodyErr) return;
    const saved = await save(s);
    if (saved) onSaved(saved);
  }

  async function del() {
    const ok = await confirmAction({
      title: `Delete "${snippetPath(initial)}"?`,
      description: "The snippet is removed from the library.",
      confirmLabel: "Delete snippet",
      destructive: true,
    });
    if (ok) {
      await remove(initial);
      onSaved(BLANK);
    }
  }

  return (
    <form
      aria-label={initial.id ? `Edit ${initial.name}` : "New snippet"}
      className="flex flex-col gap-4 p-4"
      onSubmit={(e) => void submit(e)}
      noValidate
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" error={touched ? nameError : undefined}>
          <Input autoFocus value={s.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="Folder" description='Use "/" for subfolders'>
          <Input
            placeholder="Cisco/Interfaces"
            value={s.folder}
            onChange={(e) => set("folder", e.target.value)}
          />
        </Field>
      </div>
      <Field label="Vendor" description="Shown in the snippet bar of that vendor's devices">
        <NativeSelect value={s.vendor} onChange={(e) => set("vendor", e.target.value)}>
          <option value="">Any device</option>
          {[...new Set([...vendors, s.vendor].filter(Boolean))].map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field
        label="Commands"
        description="One command per line. Variables: {{interface}} or {{vlan:20}} (with default)."
        error={touched || s.body ? bodyErr : undefined}
      >
        <textarea
          aria-label="Commands"
          rows={8}
          spellCheck={false}
          className="min-h-32 rounded-md border border-border bg-surface p-2.5 font-mono text-[13px] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
          value={s.body}
          onChange={(e) => set("body", e.target.value)}
        />
      </Field>
      <Field label="Description">
        <Input value={s.description} onChange={(e) => set("description", e.target.value)} />
      </Field>
      <div className="flex gap-2">
        {initial.id > 0 && (
          <Button
            type="button"
            variant="ghost"
            className="mr-auto text-danger"
            onClick={() => void del()}
          >
            <Trash2 size={14} /> Delete
          </Button>
        )}
        <span className="flex-1" />
        {initial.id > 0 && (
          <Button type="button" variant="ghost" onClick={() => runSnippet(initial)}>
            <Play size={14} /> Insert
          </Button>
        )}
        <Button type="submit" variant="primary">
          {initial.id ? "Save" : "Add snippet"}
        </Button>
      </div>
    </form>
  );
}

/** Snippet library: folders on the left, the selected snippet's editor on the right. */
export function SnippetsManager() {
  const open = useSnippets((s) => s.managerOpen);
  const select = useSnippets((s) => s.managerSelect);
  const close = useSnippets((s) => s.closeManager);
  return (
    <Sheet open={open} onOpenChange={(o) => !o && close()}>
      {open && <Library key={select ?? 0} initial={select ?? 0} />}
    </Sheet>
  );
}

function Library({ initial }: { initial: number }) {
  const list = useSnippets((s) => s.list);
  const load = useSnippets((s) => s.load);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState<number>(initial);

  useEffect(() => {
    void load();
    void useInventory.getState().load();
  }, [load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list ?? []).filter(
      (s) =>
        !q ||
        snippetPath(s).toLowerCase().includes(q) ||
        s.body.toLowerCase().includes(q) ||
        s.vendor.toLowerCase().includes(q),
    );
  }, [list, query]);
  const selected = (list ?? []).find((s) => s.id === current) ?? BLANK;

  return (
    <SheetContent
      title="Snippets"
      description="Saved commands, typed into the active session from the palette or the snippet bar."
      className="w-[min(860px,calc(100vw-16px))]"
      actions={
        <Button size="sm" variant="ghost" onClick={() => setCurrent(0)}>
          <Plus size={14} /> New
        </Button>
      }
    >
      <div className="grid h-full min-h-0 grid-cols-[280px_1fr]">
        <nav aria-label="Snippet library" className="flex min-h-0 flex-col border-r border-border">
          <div className="relative p-2">
            <Search
              size={12}
              className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-fg-subtle"
            />
            <Input
              aria-label="Search snippets"
              placeholder="Search snippets"
              className="pl-7"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {list && shown.length === 0 && (
              <p className="p-2 text-xs text-fg-subtle">
                {query ? "No snippets match." : "No snippets yet."}
              </p>
            )}
            {groupByFolder(shown).map(([folder, items]) => (
              <section key={folder} className="mb-2">
                <h3 className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-fg-muted">
                  <FolderClosed size={12} /> {folder || "Top level"}
                </h3>
                <ul>
                  {items.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        aria-current={s.id === current ? "true" : undefined}
                        onClick={() => setCurrent(s.id)}
                        onDoubleClick={() => runSnippet(s)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-surface-raised",
                          s.id === current && "bg-accent-subtle hover:bg-accent-subtle",
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">{s.name}</span>
                        {s.variables.length > 0 && (
                          <Braces size={12} aria-label="Has variables" className="text-fg-subtle" />
                        )}
                        {s.vendor && (
                          <span className="text-[10px] tracking-wide text-fg-subtle uppercase">
                            {s.vendor}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </nav>
        <div className="min-h-0 overflow-y-auto">
          {list?.length === 0 && (
            <p className="mx-4 mt-4 flex items-start gap-2 rounded-md bg-surface-raised p-3 text-xs text-fg-muted">
              <Braces size={14} className="mt-px shrink-0" aria-hidden />
              Save commands you type often. Variables like {"{{interface}}"} are asked for when you
              insert a snippet.
            </p>
          )}
          <Editor key={selected.id} initial={selected} onSaved={(s) => setCurrent(s.id)} />
        </div>
      </div>
    </SheetContent>
  );
}
