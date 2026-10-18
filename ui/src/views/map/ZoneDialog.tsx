import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import type { Zone } from "@/lib/ipc";
import { useMap } from "@/stores/map";
import { VLAN_COLORS } from "@/views/inventory/model";
import { useMapUi } from "./mapUi";

/** Create or edit a zone (name, color, lock). */
export function ZoneDialog() {
  const initial = useMapUi((s) => s.zoneDialog);
  return initial ? <ZoneForm key={initial.id} initial={initial} /> : null;
}

function ZoneForm({ initial }: { initial: Zone }) {
  const close = () => useMapUi.getState().setZoneDialog(null);
  const [zone, setZone] = useState<Zone>(initial);
  const set = <K extends keyof Zone>(k: K, v: Zone[K]) => setZone((z) => ({ ...z, [k]: v }));
  const nameError = !zone.name.trim() ? "Enter a name." : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (nameError) return;
    if (await useMap.getState().saveZone({ ...zone, name: zone.name.trim() })) close();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent
        title={initial.id ? `Edit ${initial.name}` : "New zone"}
        description="Zones group devices on this view, e.g. DMZ, Server farm or Core. Devices inside move with the zone."
      >
        <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
          <Field label="Name" error={zone.name ? nameError : undefined}>
            <Input autoFocus value={zone.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-xs font-medium text-fg-muted">Color</legend>
            <div className="flex items-center gap-2" role="radiogroup" aria-label="Color">
              <button
                type="button"
                role="radio"
                aria-checked={!zone.color}
                aria-label="No color"
                onClick={() => set("color", "")}
                className="size-6 rounded-full border border-border aria-checked:ring-2 aria-checked:ring-ring"
              />
              {VLAN_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={zone.color === c}
                  aria-label={c}
                  onClick={() => set("color", c)}
                  className="size-6 rounded-full aria-checked:ring-2 aria-checked:ring-ring aria-checked:ring-offset-2 aria-checked:ring-offset-surface"
                  style={{ background: c }}
                />
              ))}
            </div>
          </fieldset>
          <label className="flex items-center gap-2 text-[13px]">
            <Switch
              checked={zone.locked}
              onCheckedChange={(v) => set("locked", v)}
              aria-label="Lock zone"
            />
            Lock position and size
          </label>
          <DialogFooter>
            {initial.id !== 0 && (
              <Button
                type="button"
                variant="ghost"
                className="mr-auto text-danger"
                onClick={() => {
                  void useMap.getState().deleteZone(initial);
                  close();
                }}
              >
                Delete zone
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={Boolean(nameError)}>
              {initial.id ? "Save" : "Add zone"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
