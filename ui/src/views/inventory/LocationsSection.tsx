import {
  Building2,
  ChevronRight,
  Layers,
  MapPin,
  MoreHorizontal,
  Plus,
  Rows3,
  DoorOpen,
} from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
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
import { cn } from "@/lib/cn";
import * as ipc from "@/lib/ipc";
import type { InventorySnapshot, LocationInput, LocationKind } from "@/lib/ipc";
import { confirmAction } from "@/stores/confirm";
import { mutate } from "./mutate";
import { blankLocation } from "./model";

const NOUN: Record<LocationKind, string> = {
  site: "site",
  building: "building",
  floor: "floor",
  room: "room",
  rack: "rack",
};

function LocationDialog({
  value,
  snapshot,
  onClose,
}: {
  value: LocationInput;
  snapshot: InventorySnapshot;
  onClose: () => void;
}) {
  const [loc, setLoc] = useState<LocationInput>(value);
  const [touched, setTouched] = useState(false);
  const set = (patch: Record<string, unknown>) =>
    setLoc((l) => ({ ...l, ...patch }) as LocationInput);
  const nameError = touched && !loc.name.trim() ? `Enter a ${NOUN[loc.kind]} name.` : undefined;
  const heightError =
    loc.kind === "rack" && (loc.heightU < 1 || loc.heightU > 60) ? "1–60 U." : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!loc.name.trim() || heightError) return;
    const saved = await mutate(() => ipc.locationSave({ ...loc, name: loc.name.trim() }), {
      error: `Could not save the ${NOUN[loc.kind]}`,
    });
    if (saved) onClose();
  }

  const verb = loc.id ? "Edit" : "New";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`${verb} ${NOUN[loc.kind]}`}>
        <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
          <Field label="Name" error={nameError}>
            <Input autoFocus value={loc.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          {loc.kind === "building" && (
            <div className="grid grid-cols-[120px_1fr] gap-3">
              <Field label="Code">
                <Input value={loc.code} onChange={(e) => set({ code: e.target.value })} />
              </Field>
              <Field label="Address">
                <Input value={loc.address} onChange={(e) => set({ address: e.target.value })} />
              </Field>
            </div>
          )}
          {loc.kind === "floor" && (
            <Field label="Level" description="Sort order: 0 = ground floor, negative = basement.">
              <Input
                type="number"
                value={loc.level}
                onChange={(e) => set({ level: Math.trunc(Number(e.target.value) || 0) })}
              />
            </Field>
          )}
          {loc.kind === "rack" && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Height (U)" error={heightError}>
                <Input
                  type="number"
                  min={1}
                  max={60}
                  value={loc.heightU}
                  onChange={(e) => set({ heightU: Math.trunc(Number(e.target.value) || 0) })}
                />
              </Field>
              <Field label="Room">
                <NativeSelect
                  value={loc.roomId ?? ""}
                  onChange={(e) => set({ roomId: e.target.value ? Number(e.target.value) : null })}
                >
                  <option value="">—</option>
                  {snapshot.rooms
                    .filter((r) => r.floorId === loc.floorId)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                </NativeSelect>
              </Field>
            </div>
          )}
          <Field label="Notes">
            <Input value={loc.notes} onChange={(e) => set({ notes: e.target.value })} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              {loc.id ? "Save" : `Add ${NOUN[loc.kind]}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface NodeProps {
  icon: ReactNode;
  label: string;
  meta?: string;
  depth: number;
  open?: boolean;
  onToggle?: () => void;
  menu: ReactNode;
  children?: ReactNode;
}

function Node({ icon, label, meta, depth, open, onToggle, menu, children }: NodeProps) {
  return (
    <li role="treeitem" aria-expanded={onToggle ? open : undefined} aria-label={label}>
      <div
        className="group flex h-8 items-center gap-2 rounded-md pr-2 hover:bg-surface-raised"
        style={{ paddingLeft: 8 + depth * 20 }}
      >
        {onToggle ? (
          <button
            type="button"
            aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
            onClick={onToggle}
            className="text-fg-subtle hover:text-fg"
          >
            <ChevronRight
              size={14}
              className={cn("transition-transform duration-150", open && "rotate-90")}
            />
          </button>
        ) : (
          <span className="w-3.5" />
        )}
        <span className="text-fg-muted">{icon}</span>
        <span className="font-medium">{label}</span>
        {meta && <span className="text-xs text-fg-subtle">{meta}</span>}
        <span className="flex-1" />
        <span className="opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
          {menu}
        </span>
      </div>
      {open && children && <ul role="group">{children}</ul>}
    </li>
  );
}

function NodeMenu({
  label,
  add,
  onEdit,
  onDelete,
}: {
  label: string;
  add: { label: string; run: () => void }[];
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" aria-label={`Actions for ${label}`}>
          <MoreHorizontal size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {add.map((a) => (
          <DropdownMenuItem key={a.label} icon={<Plus size={14} />} onSelect={a.run}>
            {a.label}
          </DropdownMenuItem>
        ))}
        {add.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={onEdit}>Edit</DropdownMenuItem>
        <DropdownMenuItem destructive onSelect={onDelete}>
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Site → building → floor → room / rack tree with inline management. */
export function LocationsSection({ snapshot }: { snapshot: InventorySnapshot }) {
  const [editing, setEditing] = useState<LocationInput | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const isOpen = (key: string) => !collapsed.has(key);
  const count = (pred: (d: InventorySnapshot["devices"][number]) => boolean) => {
    const n = snapshot.devices.filter(pred).length;
    return n ? `${n} device${n === 1 ? "" : "s"}` : undefined;
  };

  async function remove(kind: LocationKind, id: number, name: string) {
    const ok = await confirmAction({
      title: `Delete ${name}?`,
      description: `Everything inside this ${NOUN[kind]} is deleted too. Devices stay in the inventory without this location.`,
      confirmLabel: `Delete ${NOUN[kind]}`,
      destructive: true,
    });
    if (ok) await mutate(() => ipc.locationDelete(kind, id), { error: `Could not delete ${name}` });
  }

  const site = snapshot.sites[0];
  const multiSite = snapshot.sites.length > 1;
  const addBuilding = (siteId: number) => setEditing(blankLocation("building", siteId));

  if (snapshot.buildings.length === 0 && !multiSite) {
    return (
      <>
        <EmptyState
          icon={<Building2 size={20} />}
          title="No buildings yet"
          description="Model your campus as buildings, floors, rooms and racks. Devices can then be placed down to the rack unit."
          action={
            site ? { label: "Add a building", onClick: () => addBuilding(site.id) } : undefined
          }
        />
        {editing && (
          <LocationDialog value={editing} snapshot={snapshot} onClose={() => setEditing(null)} />
        )}
      </>
    );
  }

  const buildingsOf = (siteId: number) =>
    snapshot.buildings
      .filter((b) => b.siteId === siteId)
      .map((b) => (
        <Node
          key={`b${b.id}`}
          icon={<Building2 size={14} />}
          label={b.name}
          meta={[b.code, count((d) => d.buildingId === b.id)].filter(Boolean).join(" · ")}
          depth={multiSite ? 1 : 0}
          open={isOpen(`b${b.id}`)}
          onToggle={() => toggle(`b${b.id}`)}
          menu={
            <NodeMenu
              label={b.name}
              add={[{ label: "Add floor", run: () => setEditing(blankLocation("floor", b.id)) }]}
              onEdit={() => setEditing({ kind: "building", ...b })}
              onDelete={() => void remove("building", b.id, b.name)}
            />
          }
        >
          {snapshot.floors
            .filter((f) => f.buildingId === b.id)
            .map((f) => (
              <Node
                key={`f${f.id}`}
                icon={<Layers size={14} />}
                label={f.name}
                meta={count((d) => d.floorId === f.id)}
                depth={multiSite ? 2 : 1}
                open={isOpen(`f${f.id}`)}
                onToggle={() => toggle(`f${f.id}`)}
                menu={
                  <NodeMenu
                    label={f.name}
                    add={[
                      { label: "Add room", run: () => setEditing(blankLocation("room", f.id)) },
                      { label: "Add rack", run: () => setEditing(blankLocation("rack", f.id)) },
                    ]}
                    onEdit={() => setEditing({ kind: "floor", ...f })}
                    onDelete={() => void remove("floor", f.id, f.name)}
                  />
                }
              >
                {snapshot.rooms
                  .filter((r) => r.floorId === f.id)
                  .map((r) => (
                    <Node
                      key={`r${r.id}`}
                      icon={<DoorOpen size={14} />}
                      label={r.name}
                      meta={count((d) => d.roomId === r.id)}
                      depth={multiSite ? 3 : 2}
                      menu={
                        <NodeMenu
                          label={r.name}
                          add={[]}
                          onEdit={() => setEditing({ kind: "room", ...r })}
                          onDelete={() => void remove("room", r.id, r.name)}
                        />
                      }
                    />
                  ))}
                {snapshot.racks
                  .filter((r) => r.floorId === f.id)
                  .map((r) => {
                    const used = snapshot.devices
                      .filter((d) => d.rackId === r.id && d.rackU !== null)
                      .reduce((n, d) => n + d.uHeight, 0);
                    const room = snapshot.rooms.find((x) => x.id === r.roomId);
                    return (
                      <Node
                        key={`k${r.id}`}
                        icon={<Rows3 size={14} />}
                        label={r.name}
                        meta={[room?.name, `${used}/${r.heightU} U used`]
                          .filter(Boolean)
                          .join(" · ")}
                        depth={multiSite ? 3 : 2}
                        menu={
                          <NodeMenu
                            label={r.name}
                            add={[]}
                            onEdit={() => setEditing({ kind: "rack", ...r })}
                            onDelete={() => void remove("rack", r.id, r.name)}
                          />
                        }
                      />
                    );
                  })}
              </Node>
            ))}
        </Node>
      ));

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        {site && (
          <Button size="sm" variant="primary" onClick={() => addBuilding(site.id)}>
            <Plus size={14} /> Add building
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setEditing(blankLocation("site", 0))}>
          <MapPin size={14} /> Add site
        </Button>
      </div>
      <ul role="tree" aria-label="Locations" className="text-[13px]">
        {multiSite
          ? snapshot.sites.map((s) => (
              <Node
                key={`s${s.id}`}
                icon={<MapPin size={14} />}
                label={s.name}
                depth={0}
                open={isOpen(`s${s.id}`)}
                onToggle={() => toggle(`s${s.id}`)}
                menu={
                  <NodeMenu
                    label={s.name}
                    add={[{ label: "Add building", run: () => addBuilding(s.id) }]}
                    onEdit={() => setEditing({ kind: "site", ...s })}
                    onDelete={() => void remove("site", s.id, s.name)}
                  />
                }
              >
                {buildingsOf(s.id)}
              </Node>
            ))
          : site && buildingsOf(site.id)}
      </ul>
      {editing && (
        <LocationDialog value={editing} snapshot={snapshot} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}
