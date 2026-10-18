import { Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { NativeSelect } from "@/components/ui/NativeSelect";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Skeleton } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/cn";
import * as ipc from "@/lib/ipc";
import type { Device, Interface, InterfaceKind, InterfaceMode } from "@/lib/ipc";
import { confirmAction } from "@/stores/confirm";
import { useNotifications } from "@/stores/notifications";
import { INTERFACE_KINDS } from "./labels";
import { mutate } from "./mutate";
import { parseVlanList } from "./validate";
import { IFACE_TEMPLATE } from "./model";

const MODES: readonly { value: InterfaceMode; label: string }[] = [
  { value: "access", label: "Access" },
  { value: "trunk", label: "Trunk" },
  { value: "routed", label: "Routed" },
];

function vlanSummary(i: Interface): string {
  if (i.mode === "access") return i.accessVlan ? String(i.accessVlan) : "";
  if (i.mode === "trunk") {
    const native = i.nativeVlan ? ` (native ${i.nativeVlan})` : "";
    return `${i.allowedVlans || "all"}${native}`;
  }
  return "";
}

function vlanInput(v: string): number | null {
  const n = Number(v);
  return v.trim() && Number.isInteger(n) ? n : null;
}

function vlanError(i: Interface): string | undefined {
  const bad = (v: number | null) => v !== null && (v < 1 || v > 4094);
  if (bad(i.accessVlan) || bad(i.nativeVlan)) return "VLAN ids are 1–4094.";
  if (i.mode === "trunk" && parseVlanList(i.allowedVlans) === null)
    return "Allowed VLANs look like 10,20-30.";
  return undefined;
}

/** Shared fields of the edit and bulk-create dialogs. */
function InterfaceFields({
  value,
  set,
}: {
  value: Interface;
  set: <K extends keyof Interface>(k: K, v: Interface[K]) => void;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Type">
          <NativeSelect
            value={value.kind}
            onChange={(e) => set("kind", e.target.value as InterfaceKind)}
          >
            {INTERFACE_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Speed" description="e.g. 1G, 10G, 100M">
          <Input value={value.speed} onChange={(e) => set("speed", e.target.value)} />
        </Field>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-fg-muted">Mode</span>
        <SegmentedControl
          label="Mode"
          value={value.mode}
          options={MODES}
          onChange={(v) => set("mode", v)}
        />
      </div>
      {value.mode === "access" && (
        <Field label="Access VLAN">
          <Input
            type="number"
            min={1}
            max={4094}
            value={value.accessVlan ?? ""}
            onChange={(e) => set("accessVlan", vlanInput(e.target.value))}
          />
        </Field>
      )}
      {value.mode === "trunk" && (
        <div className="grid grid-cols-[1fr_120px] gap-3">
          <Field label="Allowed VLANs" description="Empty means all.">
            <Input
              spellCheck={false}
              value={value.allowedVlans}
              onChange={(e) => set("allowedVlans", e.target.value)}
            />
          </Field>
          <Field label="Native VLAN">
            <Input
              type="number"
              min={1}
              max={4094}
              value={value.nativeVlan ?? ""}
              onChange={(e) => set("nativeVlan", vlanInput(e.target.value))}
            />
          </Field>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="LAG membership" description="e.g. Po1, ae0">
          <Input
            spellCheck={false}
            value={value.lag}
            onChange={(e) => set("lag", e.target.value)}
          />
        </Field>
        <label className="mt-6 flex h-8 items-center gap-2 text-[13px]">
          <Switch
            checked={value.enabled}
            onCheckedChange={(v) => set("enabled", v)}
            aria-label="Enabled"
          />
          Enabled
        </label>
      </div>
    </>
  );
}

function useForm(initial: Interface) {
  const [value, setValue] = useState(initial);
  const set = <K extends keyof Interface>(k: K, v: Interface[K]) =>
    setValue((x) => ({ ...x, [k]: v }));
  return [value, set, setValue] as const;
}

function BulkDialog({
  device,
  open,
  onClose,
  onCreated,
}: {
  device: Device;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [pattern, setPattern] = useState("");
  const [preview, setPreview] = useState<{ names: string[]; error: string | null }>({
    names: [],
    error: null,
  });
  const [template, set] = useForm({ ...IFACE_TEMPLATE, deviceId: device.id });

  useEffect(() => {
    if (!pattern.trim()) return;
    let alive = true;
    const t = setTimeout(() => {
      ipc
        .interfacesExpand(pattern)
        .then((names) => alive && setPreview({ names, error: null }))
        .catch(
          (e: unknown) =>
            alive && setPreview({ names: [], error: ipc.CommandError.from(e).message }),
        );
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [pattern]);

  const names = pattern.trim() ? preview.names : [];
  const error = (pattern.trim() ? preview.error : null) ?? vlanError(template);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (names.length === 0 || error) return;
    const result = await mutate(() => ipc.interfacesBulkCreate(device.id, pattern, template), {
      error: "Could not add the interfaces",
    });
    if (!result) return;
    const skipped = result.skipped.length ? `; ${result.skipped.length} already existed` : "";
    useNotifications.getState().notify({
      variant: "success",
      title: `Added ${result.created.length} interfaces to ${device.hostname}${skipped}`,
    });
    setPattern("");
    onCreated();
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`Add interfaces to ${device.hostname}`}
        description="Names or ranges, separated by commas. Existing names are skipped."
        className="w-[min(560px,calc(100vw-32px))]"
      >
        <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
          <Field
            label="Names"
            error={pattern.trim() ? (preview.error ?? undefined) : undefined}
            description={
              names.length > 0
                ? `${names.length} interfaces: ${names.slice(0, 3).join(", ")}${names.length > 4 ? ", …" : ""}${names.length > 3 ? `, ${names[names.length - 1]}` : ""}`
                : "e.g. Gi1/0/1-48, Te1/1/1-4 or xe-0/0/[0-47]"
            }
          >
            <Input
              autoFocus
              spellCheck={false}
              className="font-mono"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
            />
          </Field>
          <InterfaceFields value={template} set={set} />
          <Field label="Description">
            <Input
              value={template.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </Field>
          {vlanError(template) && <p className="text-xs text-danger">{vlanError(template)}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={names.length === 0 || Boolean(error)}>
              {names.length > 0 ? `Add ${names.length}` : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({
  iface,
  onClose,
  onSaved,
}: {
  iface: Interface;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, set] = useForm(iface);
  const error = vlanError(value) ?? (value.name.trim() ? undefined : "Enter a name.");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (error) return;
    const saved = await mutate(() => ipc.interfaceSave(value), {
      error: `Could not save ${iface.name}`,
    });
    if (saved) {
      onSaved();
      onClose();
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Edit ${iface.name}`} className="w-[min(560px,calc(100vw-32px))]">
        <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
          <Field label="Name">
            <Input
              autoFocus
              spellCheck={false}
              className="font-mono"
              value={value.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </Field>
          <InterfaceFields value={value} set={set} />
          <Field label="Description">
            <Input value={value.description} onChange={(e) => set("description", e.target.value)} />
          </Field>
          {error && <p className="text-xs text-danger">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={Boolean(error)}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Interfaces of one device. */
export function InterfacesPanel({ device }: { device: Device }) {
  const [list, setList] = useState<Interface[] | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Interface | null>(null);

  const reload = useCallback(() => {
    ipc
      .interfacesList(device.id)
      .then(setList)
      .catch((e: unknown) =>
        useNotifications.getState().notifyError(e, "Could not load interfaces"),
      );
  }, [device.id]);

  useEffect(reload, [reload, device.interfaceCount]);

  async function removeSelected() {
    const ok = await confirmAction({
      title: `Delete ${selected.length} interfaces?`,
      description: `They are removed from ${device.hostname}. This is recorded in the audit log.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const n = await mutate(() => ipc.interfacesDelete(device.id, selected), {
      error: "Could not delete the interfaces",
    });
    if (n !== undefined) {
      setSelected([]);
      reload();
    }
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
          <Plus size={14} /> Add interfaces
        </Button>
        {selected.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => void removeSelected()}>
            <Trash2 size={14} /> Delete {selected.length}
          </Button>
        )}
        <span className="flex-1" />
        {list && <span className="text-xs text-fg-subtle">{list.length} interfaces</span>}
      </div>
      {list === null ? (
        <div className="flex flex-col gap-1">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-7" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <p className="py-6 text-center text-fg-muted">
          No interfaces yet. Add a range like Gi1/0/1-48 in one go.
        </p>
      ) : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              <th className="w-6 py-1">
                <input
                  type="checkbox"
                  aria-label="Select all interfaces"
                  className="accent-[var(--accent)]"
                  checked={selected.length === list.length}
                  onChange={(e) => setSelected(e.target.checked ? list.map((i) => i.id) : [])}
                />
              </th>
              <th className="py-1 font-medium">Name</th>
              <th className="py-1 font-medium">Type</th>
              <th className="py-1 font-medium">Mode</th>
              <th className="py-1 font-medium">VLAN</th>
              <th className="py-1 font-medium">Description</th>
            </tr>
          </thead>
          <tbody>
            {list.map((i) => (
              <tr
                key={i.id}
                className={cn(
                  "border-t border-border/60 hover:bg-surface-raised",
                  !i.enabled && "text-fg-subtle",
                )}
              >
                <td className="py-1">
                  <input
                    type="checkbox"
                    aria-label={`Select ${i.name}`}
                    className="accent-[var(--accent)]"
                    checked={selected.includes(i.id)}
                    onChange={(e) =>
                      setSelected((s) =>
                        e.target.checked ? [...s, i.id] : s.filter((x) => x !== i.id),
                      )
                    }
                  />
                </td>
                <td className="py-1">
                  <button
                    type="button"
                    className="font-mono text-xs hover:text-accent"
                    onClick={() => setEditing(i)}
                  >
                    {i.name}
                  </button>
                  {i.lag && <span className="ml-1 text-xs text-fg-subtle">→ {i.lag}</span>}
                </td>
                <td className="py-1 text-fg-muted">
                  {INTERFACE_KINDS.find((k) => k.value === i.kind)?.label} {i.speed}
                </td>
                <td className="py-1 text-fg-muted">{i.enabled ? i.mode : "disabled"}</td>
                <td className="py-1 font-mono text-xs text-fg-muted">{vlanSummary(i)}</td>
                <td className="max-w-40 truncate py-1 text-fg-muted" title={i.description}>
                  {i.description}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <BulkDialog
        device={device}
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={reload}
      />
      {editing && <EditDialog iface={editing} onClose={() => setEditing(null)} onSaved={reload} />}
    </div>
  );
}
