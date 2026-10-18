import { AlertTriangle } from "lucide-react";
import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { NativeSelect } from "@/components/ui/NativeSelect";
import * as ipc from "@/lib/ipc";
import type { Device, DeviceType, InventorySnapshot } from "@/lib/ipc";
import { useNotifications } from "@/stores/notifications";
import { ConnectionsEditor } from "./ConnectionsEditor";
import { CustomFieldInput } from "./CustomFieldInput";
import { DEVICE_TYPES } from "./labels";
import { mutate } from "./mutate";
import { formatVlanList, parseVlanList } from "./validate";
import { validateDevice, type FormState } from "./model";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

const ADD_VENDOR = "__add__";

/** Create or edit a device. */
export function DeviceForm({
  snapshot,
  initial,
  onDone,
}: {
  snapshot: InventorySnapshot;
  initial: Device;
  onDone: (saved: Device | null) => void;
}) {
  const [form, setForm] = useState<FormState>({
    device: initial,
    vlans: formatVlanList(initial.vlans),
    tags: initial.tags.join(", "),
  });
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newVendor, setNewVendor] = useState<string | null>(null);
  const d = form.device;
  const set = <K extends keyof Device>(k: K, v: Device[K]) =>
    setForm((f) => ({ ...f, device: { ...f.device, [k]: v } }));
  const errors = touched ? validateDevice(form, snapshot) : {};

  const floors = snapshot.floors.filter((f) => f.buildingId === d.buildingId);
  const rooms = snapshot.rooms.filter((r) => r.floorId === d.floorId);
  const racks = snapshot.racks.filter(
    (r) => r.floorId === d.floorId && (d.roomId === null || r.roomId === d.roomId),
  );

  function setLocation(patch: Partial<Device>) {
    setForm((f) => {
      const next = { ...f.device, ...patch };
      // Clear levels that no longer belong to the chosen parent.
      if (!snapshot.floors.some((x) => x.id === next.floorId && x.buildingId === next.buildingId))
        next.floorId = null;
      if (!snapshot.rooms.some((x) => x.id === next.roomId && x.floorId === next.floorId))
        next.roomId = null;
      const rack = snapshot.racks.find((x) => x.id === next.rackId);
      if (
        !rack ||
        rack.floorId !== next.floorId ||
        (next.roomId !== null && rack.roomId !== next.roomId)
      )
        next.rackId = null;
      if (next.rackId === null) next.rackU = null;
      return { ...f, device: next };
    });
  }

  async function addVendor() {
    const name = newVendor?.trim();
    if (!name) return;
    const saved = await mutate(() => ipc.vendorAdd(name), { error: "Could not add the vendor" });
    if (saved) {
      set("vendor", saved);
      setNewVendor(null);
    }
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setTouched(true);
    if (Object.keys(validateDevice(form, snapshot)).length > 0) return;
    setSaving(true);
    const device: Device = {
      ...d,
      hostname: d.hostname.trim(),
      mgmtIp: d.mgmtIp.trim(),
      vlans: parseVlanList(form.vlans) ?? [],
      tags: form.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    };
    const result = await mutate(() => ipc.deviceSave(device), {
      error: d.id ? `Could not save ${d.hostname}` : "Could not add the device",
    });
    setSaving(false);
    if (!result) return;
    for (const w of result.warnings)
      useNotifications
        .getState()
        .notify({ variant: "warning", title: "Check this device", description: w });
    onDone(result.device);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  }

  const idOrNull = (v: string) => (v ? Number(v) : null);

  return (
    <form
      className="flex flex-col gap-6 p-4"
      onSubmit={(e) => void submit(e)}
      onKeyDown={onKeyDown}
      noValidate
      aria-label={d.id ? `Edit ${initial.hostname}` : "New device"}
    >
      <Section title="Device">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Hostname" error={errors.hostname}>
            <Input
              autoFocus
              spellCheck={false}
              autoCapitalize="off"
              placeholder="core-sw1"
              value={d.hostname}
              onChange={(e) => set("hostname", e.target.value)}
            />
          </Field>
          <Field label="Management IP" error={errors.mgmtIp}>
            <Input
              spellCheck={false}
              placeholder="10.0.0.1"
              className="font-mono"
              value={d.mgmtIp}
              onChange={(e) => set("mgmtIp", e.target.value)}
            />
          </Field>
          <Field label="Type">
            <NativeSelect
              value={d.deviceType}
              onChange={(e) => set("deviceType", e.target.value as DeviceType)}
            >
              {DEVICE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {newVendor === null ? (
            <Field label="Vendor">
              <NativeSelect
                value={d.vendor}
                onChange={(e) =>
                  e.target.value === ADD_VENDOR ? setNewVendor("") : set("vendor", e.target.value)
                }
              >
                {snapshot.vendors.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
                <option value={ADD_VENDOR}>Add vendor…</option>
              </NativeSelect>
            </Field>
          ) : (
            <Field label="New vendor">
              <div className="flex gap-2">
                <Input
                  autoFocus
                  value={newVendor}
                  onChange={(e) => setNewVendor(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void addVendor();
                    } else if (e.key === "Escape") {
                      e.stopPropagation();
                      setNewVendor(null);
                    }
                  }}
                />
                <Button type="button" size="md" onClick={() => void addVendor()}>
                  Add
                </Button>
              </div>
            </Field>
          )}
          <Field label="Model">
            <Input value={d.model} onChange={(e) => set("model", e.target.value)} />
          </Field>
          <Field label="Serial number">
            <Input
              spellCheck={false}
              value={d.serial}
              onChange={(e) => set("serial", e.target.value)}
            />
          </Field>
          <Field label="Firmware">
            <Input value={d.firmware} onChange={(e) => set("firmware", e.target.value)} />
          </Field>
          <Field label="Credentials">
            <NativeSelect
              value={d.credentialId ?? ""}
              onChange={(e) => set("credentialId", idOrNull(e.target.value))}
            >
              <option value="">None (ask when connecting)</option>
              {snapshot.credentials.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
      </Section>

      <Section title="Location">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Building">
            <NativeSelect
              value={d.buildingId ?? ""}
              onChange={(e) => setLocation({ buildingId: idOrNull(e.target.value) })}
            >
              <option value="">—</option>
              {snapshot.buildings.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Floor">
            <NativeSelect
              disabled={d.buildingId === null}
              value={d.floorId ?? ""}
              onChange={(e) => setLocation({ floorId: idOrNull(e.target.value) })}
            >
              <option value="">—</option>
              {floors.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Room">
            <NativeSelect
              disabled={d.floorId === null || rooms.length === 0}
              value={d.roomId ?? ""}
              onChange={(e) => setLocation({ roomId: idOrNull(e.target.value) })}
            >
              <option value="">—</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Rack">
            <NativeSelect
              disabled={d.floorId === null || racks.length === 0}
              value={d.rackId ?? ""}
              onChange={(e) => setLocation({ rackId: idOrNull(e.target.value) })}
            >
              <option value="">—</option>
              {racks.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.heightU} U)
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Position (lowest U)" error={errors.rackU}>
            <Input
              type="number"
              min={1}
              disabled={d.rackId === null}
              value={d.rackU ?? ""}
              onChange={(e) =>
                set("rackU", e.target.value ? Math.trunc(Number(e.target.value)) : null)
              }
            />
          </Field>
          <Field label="Height (U)">
            <Input
              type="number"
              min={1}
              max={60}
              value={d.uHeight}
              onChange={(e) =>
                set("uHeight", Math.min(60, Math.max(1, Math.trunc(Number(e.target.value) || 1))))
              }
            />
          </Field>
        </div>
      </Section>

      <Section title="Connections">
        <ConnectionsEditor
          value={d.connections}
          onChange={(v) => set("connections", v)}
          mgmtIp={d.mgmtIp.trim()}
        />
        {errors.connections && <p className="text-xs text-danger">{errors.connections}</p>}
      </Section>

      <Section title="Network">
        <div className="grid grid-cols-2 gap-3">
          <Field label="VLANs" error={errors.vlans} description="e.g. 10,20-30">
            <Input
              spellCheck={false}
              value={form.vlans}
              onChange={(e) => setForm((f) => ({ ...f, vlans: e.target.value }))}
            />
          </Field>
          <Field label="Tags" description="Comma separated">
            <Input
              value={form.tags}
              onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
            />
          </Field>
        </div>
      </Section>

      {snapshot.fields.length > 0 && (
        <Section title="Custom fields">
          <div className="grid grid-cols-2 gap-3">
            {snapshot.fields.map((f) => (
              <CustomFieldInput
                key={f.id}
                field={f}
                value={d.custom[f.key]}
                onChange={(v) => set("custom", { ...d.custom, [f.key]: v })}
              />
            ))}
          </div>
        </Section>
      )}

      <Section title="Notes">
        <textarea
          aria-label="Notes (Markdown)"
          rows={5}
          placeholder="Markdown: **bold**, - lists, `code`, [links](https://…)"
          className="min-h-24 rounded-md border border-border bg-surface p-2.5 text-[13px] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
          value={d.notes}
          onChange={(e) => set("notes", e.target.value)}
        />
      </Section>

      {touched && Object.keys(errors).length > 0 && (
        <p role="alert" className="flex items-center gap-2 text-xs text-danger">
          <AlertTriangle size={12} /> Some fields need attention.
        </p>
      )}
      <div className="sticky bottom-0 -mx-4 -mb-4 flex justify-end gap-2 border-t border-border bg-surface px-4 py-3">
        <Button type="button" variant="ghost" onClick={() => onDone(null)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {d.id ? "Save" : "Add device"}
        </Button>
      </div>
    </form>
  );
}
