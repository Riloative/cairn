import { Bookmark, Columns3, ListFilter, Plus, Search, Trash2, X } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/Menu";
import { NativeSelect } from "@/components/ui/NativeSelect";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";
import { cn } from "@/lib/cn";
import * as ipc from "@/lib/ipc";
import type { InventorySnapshot } from "@/lib/ipc";
import { confirmAction } from "@/stores/confirm";
import { currentView, DEFAULT_VIEW, parseView, useInventoryTable } from "@/stores/inventoryTable";
import { useColumns } from "./columns";
import { DEVICE_TYPES } from "./labels";
import { mutate } from "./mutate";
import { EMPTY_FACETS, type Facets, type GroupBy } from "./query";

const GROUPS: readonly { value: GroupBy; label: string }[] = [
  { value: "none", label: "No grouping" },
  { value: "building", label: "Group by building" },
  { value: "type", label: "Group by type" },
  { value: "vendor", label: "Group by vendor" },
];

function CheckList({
  title,
  options,
  selected,
  onChange,
}: {
  title: string;
  options: readonly { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  if (options.length === 0) return null;
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-xs font-medium text-fg-muted">{title}</legend>
      {options.map((o) => (
        <label key={o.value} className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            className="accent-[var(--accent)]"
            checked={selected.includes(o.value)}
            onChange={(e) =>
              onChange(
                e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value),
              )
            }
          />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

function facetCount(f: Facets): number {
  return f.type.length + f.vendor.length + f.building.length + f.tag.length;
}

function ToolbarButton({
  active,
  children,
  ...props
}: { active?: boolean; children: ReactNode } & React.ComponentProps<typeof Button>) {
  return (
    <Button
      size="sm"
      variant="ghost"
      className={cn(active && "bg-accent-subtle text-fg")}
      {...props}
    >
      {children}
    </Button>
  );
}

export function DevicesToolbar({
  snapshot,
  shown,
  onNew,
}: {
  snapshot: InventorySnapshot;
  shown: number;
  onNew: () => void;
}) {
  const search = useInventoryTable((s) => s.search);
  const facets = useInventoryTable((s) => s.facets);
  const groupBy = useInventoryTable((s) => s.groupBy);
  const columns = useInventoryTable((s) => s.columns);
  const activeViewId = useInventoryTable((s) => s.activeViewId);
  const setTable = useInventoryTable((s) => s.set);
  const apply = useInventoryTable((s) => s.apply);
  const allColumns = useColumns(snapshot);
  const [saving, setSaving] = useState(false);
  const [viewName, setViewName] = useState("");

  const setFacet = <K extends keyof Facets>(k: K, v: Facets[K]) =>
    setTable({ facets: { ...facets, [k]: v } });
  const tags = [...new Set(snapshot.devices.flatMap((d) => d.tags))].sort();
  const activeView = snapshot.views.find((v) => v.id === activeViewId);
  const filters = facetCount(facets);

  async function saveView(e: FormEvent) {
    e.preventDefault();
    const name = viewName.trim();
    if (!name) return;
    const existing = snapshot.views.find((v) => v.name === name);
    const state = currentView() as unknown as Record<string, unknown>;
    const saved = await mutate(() => ipc.viewSave({ id: existing?.id ?? 0, name, state }), {
      error: "Could not save the view",
    });
    if (saved) {
      apply(parseView(saved.state), saved.id);
      setSaving(false);
    }
  }

  async function removeView(id: number, name: string) {
    const ok = await confirmAction({
      title: `Delete the view ${name}?`,
      description: "Only the saved filters and columns are removed; devices are not affected.",
      confirmLabel: "Delete view",
      destructive: true,
    });
    if (ok) await mutate(() => ipc.viewDelete(id), { error: "Could not delete the view" });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
      <div className="relative w-64">
        <Search
          size={14}
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-subtle"
        />
        <Input
          aria-label="Search devices"
          placeholder="Search hostname, IP, model, tag…"
          className="pl-8"
          value={search}
          onChange={(e) => setTable({ search: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape" && search) {
              e.stopPropagation();
              setTable({ search: "" });
            }
          }}
        />
      </div>

      <Popover>
        <PopoverTrigger asChild>
          <ToolbarButton active={filters > 0}>
            <ListFilter size={14} />
            Filter{filters > 0 ? ` (${filters})` : ""}
          </ToolbarButton>
        </PopoverTrigger>
        <PopoverContent align="start" className="max-h-[70vh] w-72 overflow-y-auto p-3">
          <div className="flex flex-col gap-4">
            <CheckList
              title="Type"
              options={DEVICE_TYPES.filter((t) =>
                snapshot.devices.some((d) => d.deviceType === t.value),
              )}
              selected={facets.type}
              onChange={(v) => setFacet("type", v as Facets["type"])}
            />
            <CheckList
              title="Vendor"
              options={[...new Set(snapshot.devices.map((d) => d.vendor))]
                .sort()
                .map((v) => ({ value: v, label: v }))}
              selected={facets.vendor}
              onChange={(v) => setFacet("vendor", v)}
            />
            <CheckList
              title="Building"
              options={[
                ...snapshot.buildings.map((b) => ({ value: String(b.id), label: b.name })),
                ...(snapshot.devices.some((d) => d.buildingId === null)
                  ? [{ value: "none", label: "No building" }]
                  : []),
              ]}
              selected={facets.building}
              onChange={(v) => setFacet("building", v)}
            />
            <CheckList
              title="Tag"
              options={tags.map((t) => ({ value: t, label: t }))}
              selected={facets.tag}
              onChange={(v) => setFacet("tag", v)}
            />
            {filters > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setTable({ facets: EMPTY_FACETS })}>
                <X size={14} /> Clear filters
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>

      <NativeSelect
        aria-label="Grouping"
        className="h-7 text-xs"
        value={groupBy}
        onChange={(e) => setTable({ groupBy: e.target.value as GroupBy })}
      >
        {GROUPS.map((g) => (
          <option key={g.value} value={g.value}>
            {g.label}
          </option>
        ))}
      </NativeSelect>

      <Popover>
        <PopoverTrigger asChild>
          <ToolbarButton>
            <Columns3 size={14} />
            Columns
          </ToolbarButton>
        </PopoverTrigger>
        <PopoverContent align="start" className="max-h-[70vh] w-56 overflow-y-auto p-3">
          <CheckList
            title="Visible columns"
            options={allColumns
              .filter((c) => c.enableHiding !== false)
              .map((c) => ({ value: String(c.id), label: String(c.header) }))}
            selected={allColumns.map((c) => String(c.id)).filter((id) => columns[id] !== false)}
            onChange={(visible) =>
              setTable({
                columns: Object.fromEntries(
                  allColumns.map((c) => [
                    String(c.id),
                    visible.includes(String(c.id)) || c.enableHiding === false,
                  ]),
                ),
              })
            }
          />
        </PopoverContent>
      </Popover>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <ToolbarButton active={activeView !== undefined}>
            <Bookmark size={14} />
            {activeView ? activeView.name : "Views"}
          </ToolbarButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => apply(DEFAULT_VIEW, null)}>
            All devices
          </DropdownMenuItem>
          {snapshot.views.map((v) => (
            <DropdownMenuItem key={v.id} onSelect={() => apply(parseView(v.state), v.id)}>
              <span className="flex-1">{v.name}</span>
              <button
                type="button"
                aria-label={`Delete view ${v.name}`}
                className="rounded p-0.5 text-fg-subtle hover:text-danger"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  void removeView(v.id, v.name);
                }}
              >
                <Trash2 size={12} />
              </button>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              setViewName(activeView?.name ?? "");
              setSaving(true);
            }}
          >
            Save current view…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <span className="flex-1" />
      <span className="text-xs text-fg-subtle" aria-live="polite">
        {shown === snapshot.devices.length
          ? `${shown} devices`
          : `${shown} of ${snapshot.devices.length} devices`}
      </span>
      <Button size="sm" variant="primary" onClick={onNew}>
        <Plus size={14} />
        New device
      </Button>

      <Dialog open={saving} onOpenChange={setSaving}>
        <DialogContent
          title="Save view"
          description="Saves the search, filters, grouping, sorting and columns."
        >
          <form onSubmit={(e) => void saveView(e)} className="flex flex-col gap-4">
            <Field label="Name">
              <Input autoFocus value={viewName} onChange={(e) => setViewName(e.target.value)} />
            </Field>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setSaving(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={!viewName.trim()}>
                Save view
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
