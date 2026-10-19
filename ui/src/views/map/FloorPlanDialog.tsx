import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import * as ipc from "@/lib/ipc";
import type { FloorPlanInfo } from "@/lib/ipc";
import { fitPlan, PLAN_SCALE, readPlanFile } from "@/map/floorplanFile";
import { bounds } from "@/map/geometry";
import { rectOf } from "@/map/model";
import { useMap } from "@/stores/map";
import { useNotifications } from "@/stores/notifications";
import { useMapUi } from "./mapUi";

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-xs font-medium text-fg-muted">
      <span className="flex justify-between">
        {label}
        <span className="font-mono text-fg">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-[var(--accent)]"
      />
    </label>
  );
}

type Place = Pick<FloorPlanInfo, "scale" | "opacity" | "x" | "y">;

/** Saves placement changes after the slider settles, not on every step. */
const SAVE_DELAY_MS = 250;

/** Scale, opacity and offset of an uploaded plan. */
function Placement({ floorId, plan }: { floorId: number; plan: FloorPlanInfo }) {
  const [place, setPlace] = useState<Place>({
    scale: plan.scale,
    opacity: plan.opacity,
    x: plan.x,
    y: plan.y,
  });
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; next: Place } | null>(null);

  const flush = useCallback(async () => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    try {
      await ipc.floorPlanPlace(floorId, p.next);
      await useMap.getState().load();
    } catch (e) {
      useNotifications.getState().notifyError(e, "Could not place the floor plan");
    }
  }, [floorId]);

  // Closing the dialog mid-drag still saves the last value.
  useEffect(() => () => void flush(), [flush]);

  function change(patch: Partial<Place>) {
    const next = { ...place, ...patch };
    setPlace(next);
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = { next, timer: setTimeout(() => void flush(), SAVE_DELAY_MS) };
  }

  return (
    <>
      <Slider
        label="Scale"
        value={place.scale}
        min={PLAN_SCALE.min}
        max={PLAN_SCALE.max}
        step={0.05}
        format={(v) => `${v.toFixed(2)}×`}
        onChange={(scale) => change({ scale })}
      />
      <Slider
        label="Opacity"
        value={place.opacity}
        min={0.05}
        max={1}
        step={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(opacity) => change({ opacity })}
      />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Offset X">
          <Input
            type="number"
            value={place.x}
            onChange={(e) => change({ x: Number(e.target.value) || 0 })}
          />
        </Field>
        <Field label="Offset Y">
          <Input
            type="number"
            value={place.y}
            onChange={(e) => change({ y: Number(e.target.value) || 0 })}
          />
        </Field>
      </div>
    </>
  );
}

/** Upload, place and remove a floor's background plan. */
export function FloorPlanDialog({
  floorId,
  plan,
}: {
  floorId: number;
  plan: FloorPlanInfo | undefined;
}) {
  const open = useMapUi((s) => s.planOpen);
  const close = () => useMapUi.getState().setPlanOpen(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  async function upload(file: File) {
    setBusy(true);
    try {
      const img = await readPlanFile(file, page);
      const saved = await ipc.floorPlanUpload(floorId, img.name, img.data, img.width, img.height);
      // A new plan starts behind the devices already on the floor.
      const nodes = useMapUi.getState().canvas?.model.nodes.filter((n) => n.kind !== "external");
      const fit = fitPlan(img.width, img.height, bounds((nodes ?? []).map(rectOf)));
      if (fit) await ipc.floorPlanPlace(floorId, { ...fit, opacity: saved.opacity });
      useMap.getState().dropPlanUrl(floorId);
      await useMap.getState().load();
      if (img.pages > 1)
        useNotifications.getState().notify({
          variant: "info",
          title: `Used page ${Math.min(page, img.pages)} of ${img.pages}`,
          description: "Choose another page number and upload again to switch.",
        });
    } catch (e) {
      useNotifications.getState().notifyError(e, "Could not use that floor plan");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    try {
      await ipc.floorPlanDelete(floorId);
      useMap.getState().dropPlanUrl(floorId);
      await useMap.getState().load();
    } catch (e) {
      useNotifications.getState().notifyError(e, "Could not remove the floor plan");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent
        title="Floor plan"
        description="A PNG, JPEG, SVG or PDF page shown behind this floor's devices. Stored in the encrypted vault."
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-end gap-3">
            <Field label="PDF page" className="w-24">
              <Input
                type="number"
                min={1}
                value={page}
                onChange={(e) => setPage(Math.max(1, Math.trunc(Number(e.target.value) || 1)))}
              />
            </Field>
            <Button
              type="button"
              variant="primary"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              {plan ? "Replace…" : "Choose file…"}
            </Button>
            <input
              ref={fileRef}
              type="file"
              hidden
              aria-label="Floor plan file"
              accept="image/png,image/jpeg,image/svg+xml,application/pdf,.pdf,.svg"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void upload(f);
              }}
            />
            {plan && <span className="truncate pb-2 text-xs text-fg-subtle">{plan.name}</span>}
          </div>
          {plan && <Placement key={`${plan.name}:${plan.bytes}`} floorId={floorId} plan={plan} />}
          <DialogFooter>
            {plan && (
              <Button
                type="button"
                variant="ghost"
                className="mr-auto text-danger"
                onClick={() => void remove()}
              >
                Remove plan
              </Button>
            )}
            <Button type="button" onClick={close}>
              Done
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
