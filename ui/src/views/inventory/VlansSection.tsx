import { Plus, Tags } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import * as ipc from "@/lib/ipc";
import type { InventorySnapshot, Vlan } from "@/lib/ipc";
import { confirmAction } from "@/stores/confirm";
import { mutate } from "./mutate";
import { VLAN_COLORS, vlanErrors } from "./model";

const BLANK: Vlan = {
  id: 0,
  vid: 0,
  name: "",
  subnet: "",
  gateway: "",
  description: "",
  color: "",
};

function VlanDialog({ initial, onClose }: { initial: Vlan; onClose: () => void }) {
  const [v, setV] = useState(initial);
  const [touched, setTouched] = useState(false);
  const set = <K extends keyof Vlan>(k: K, val: Vlan[K]) => setV((x) => ({ ...x, [k]: val }));
  const errors = touched ? vlanErrors(v) : {};

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(vlanErrors(v)).length) return;
    const saved = await mutate(() => ipc.vlanSave(v), { error: `Could not save VLAN ${v.vid}` });
    if (saved) onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={initial.id ? `Edit VLAN ${initial.vid}` : "New VLAN"}>
        <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
          <div className="grid grid-cols-[110px_1fr] gap-3">
            <Field label="VLAN ID" error={errors.vid}>
              <Input
                autoFocus
                type="number"
                min={1}
                max={4094}
                value={v.vid || ""}
                onChange={(e) => set("vid", Math.trunc(Number(e.target.value) || 0))}
              />
            </Field>
            <Field label="Name">
              <Input value={v.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Subnet" error={errors.subnet}>
              <Input
                spellCheck={false}
                className="font-mono"
                placeholder="10.1.20.0/24"
                value={v.subnet}
                onChange={(e) => set("subnet", e.target.value)}
              />
            </Field>
            <Field label="Gateway" error={errors.gateway}>
              <Input
                spellCheck={false}
                className="font-mono"
                placeholder="10.1.20.1"
                value={v.gateway}
                onChange={(e) => set("gateway", e.target.value)}
              />
            </Field>
          </div>
          <Field label="Description">
            <Input value={v.description} onChange={(e) => set("description", e.target.value)} />
          </Field>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-xs font-medium text-fg-muted">Color</legend>
            <div className="flex items-center gap-2" role="radiogroup" aria-label="Color">
              <button
                type="button"
                role="radio"
                aria-checked={!v.color}
                aria-label="No color"
                onClick={() => set("color", "")}
                className="size-6 rounded-full border border-border aria-checked:ring-2 aria-checked:ring-ring"
              />
              {VLAN_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={v.color === c}
                  aria-label={c}
                  onClick={() => set("color", c)}
                  className="size-6 rounded-full aria-checked:ring-2 aria-checked:ring-ring aria-checked:ring-offset-2 aria-checked:ring-offset-surface"
                  style={{ background: c }}
                />
              ))}
            </div>
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              {initial.id ? "Save" : "Add VLAN"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function VlansSection({ snapshot }: { snapshot: InventorySnapshot }) {
  const [editing, setEditing] = useState<Vlan | null>(null);

  async function remove(v: Vlan) {
    const ok = await confirmAction({
      title: `Delete VLAN ${v.vid}?`,
      description: "It is removed from the registry. Devices and interfaces keep their VLAN ids.",
      confirmLabel: "Delete VLAN",
      destructive: true,
    });
    if (ok) await mutate(() => ipc.vlanDelete(v.id), { error: `Could not delete VLAN ${v.vid}` });
  }

  const usage = (vid: number) => snapshot.devices.filter((d) => d.vlans.includes(vid)).length;

  return (
    <div className="flex h-full flex-col">
      {snapshot.vlans.length === 0 ? (
        <EmptyState
          icon={<Tags size={20} />}
          title="No VLANs yet"
          description="Keep a registry of VLAN ids with names, subnets and colors. The colors are reused on the map."
          action={{ label: "Add a VLAN", onClick: () => setEditing(BLANK) }}
        />
      ) : (
        <div className="flex flex-col gap-3 p-4">
          <Button
            size="sm"
            variant="primary"
            className="self-start"
            onClick={() => setEditing(BLANK)}
          >
            <Plus size={14} /> Add VLAN
          </Button>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th className="py-1 font-medium">ID</th>
                <th className="py-1 font-medium">Name</th>
                <th className="py-1 font-medium">Subnet</th>
                <th className="py-1 font-medium">Gateway</th>
                <th className="py-1 font-medium">Devices</th>
                <th className="py-1 font-medium">Description</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {snapshot.vlans.map((v) => (
                <tr key={v.id} className="border-t border-border/60 hover:bg-surface-raised">
                  <td className="py-1.5">
                    <button
                      type="button"
                      className="flex items-center gap-2 font-medium hover:text-accent"
                      onClick={() => setEditing(v)}
                    >
                      <span
                        aria-hidden
                        className="size-2.5 rounded-full border border-border"
                        style={{ background: v.color || "transparent" }}
                      />
                      {v.vid}
                    </button>
                  </td>
                  <td className="py-1.5">{v.name}</td>
                  <td className="py-1.5 font-mono text-xs text-fg-muted">{v.subnet}</td>
                  <td className="py-1.5 font-mono text-xs text-fg-muted">{v.gateway}</td>
                  <td className="py-1.5 text-fg-muted">{usage(v.vid) || ""}</td>
                  <td className="max-w-60 truncate py-1.5 text-fg-muted">{v.description}</td>
                  <td className="py-1.5 text-right">
                    <Button size="sm" variant="ghost" onClick={() => void remove(v)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <VlanDialog initial={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
