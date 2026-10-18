import { save } from "@tauri-apps/plugin-dialog";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import * as ipc from "@/lib/ipc";
import type { DiagramFormat, InventorySnapshot, MapSnapshot } from "@/lib/ipc";
import { buildSvg, toDataUrl, type ExportNode } from "@/map/exportSvg";
import type { MapViewRef } from "@/map/model";
import { useNotifications } from "@/stores/notifications";
import { useMapUi } from "./mapUi";

const FORMATS: readonly { value: DiagramFormat; label: string }[] = [
  { value: "png", label: "PNG" },
  { value: "svg", label: "SVG" },
  { value: "pdf", label: "PDF" },
];
const SCALES = [
  { value: "1", label: "1×" },
  { value: "2", label: "2×" },
  { value: "4", label: "4×" },
] as const;

/** An element carrying a theme's CSS variables (for resolving export colors). */
function themeProbe(forceLight: boolean): HTMLElement {
  const el = document.createElement("div");
  el.dataset.theme = forceLight ? "paper" : (document.documentElement.dataset.theme ?? "midnight");
  el.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  document.body.appendChild(el);
  return el;
}

export function ExportDialog({
  view,
  title,
  inv,
  map,
}: {
  view: MapViewRef;
  title: string;
  inv: InventorySnapshot;
  map: MapSnapshot;
}) {
  const open = useMapUi((s) => s.exportOpen);
  const close = () => useMapUi.getState().setExportOpen(false);
  const canvas = useMapUi((s) => s.canvas);
  const [format, setFormat] = useState<DiagramFormat>("png");
  const [scale, setScale] = useState<"1" | "2" | "4">("2");
  const [name, setName] = useState("");
  const [legend, setLegend] = useState(true);
  const [date, setDate] = useState(true);
  const [light, setLight] = useState(false);
  const [selectionOnly, setSelectionOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const selected = canvas?.selection().filter((id) => /^(d|b|z):/.test(id)) ?? [];

  async function run(e: FormEvent) {
    e.preventDefault();
    if (!canvas) return;
    setBusy(true);
    const probe = themeProbe(light);
    try {
      const only = selectionOnly && selected.length ? new Set(selected) : null;
      const live = canvas.nodes();
      const nodes: ExportNode[] = [];
      for (const n of live) {
        if (only && !only.has(n.id)) continue;
        const base = {
          key: n.id,
          x: n.position.x,
          y: n.position.y,
          w: n.width ?? 0,
          h: n.height ?? 0,
        };
        if (n.type === "device")
          nodes.push({
            ...base,
            kind: n.data.external ? "external" : "device",
            device: n.data.device,
            sub: n.data.where,
            w: 136,
            h: 84,
          });
        else if (n.type === "building")
          nodes.push({
            ...base,
            kind: "building",
            w: 200,
            h: 112,
            label: n.data.building.name,
            sub: `${n.data.floors} floors · ${n.data.devices} devices`,
          });
        else if (n.type === "band" && !only)
          nodes.push({
            ...base,
            kind: "band",
            w: n.data.width,
            h: n.data.height,
            label: n.data.label,
          });
      }
      const zones = live
        .filter((n) => n.type === "zone" && (!only || only.has(n.id)))
        .map((n) =>
          n.type === "zone"
            ? {
                ...n.data.zone,
                x: n.position.x,
                y: n.position.y,
                width: n.width ?? n.data.zone.width,
                height: n.height ?? n.data.zone.height,
              }
            : null,
        )
        .filter((z): z is NonNullable<typeof z> => z !== null);
      const keys = new Set(nodes.map((n) => n.key));
      const edges = canvas.model.edges.filter((e) => keys.has(e.source) && keys.has(e.target));
      const planInfo =
        view.kind === "floor" && !only
          ? map.floorPlans.find((p) => p.floorId === view.id)
          : undefined;
      const plan = planInfo
        ? {
            href: await toDataUrl(await ipc.floorPlanImage(planInfo.floorId), planInfo.mime),
            x: planInfo.x,
            y: planInfo.y,
            w: planInfo.width * planInfo.scale,
            h: planInfo.height * planInfo.scale,
            opacity: planInfo.opacity,
          }
        : null;
      const svg = buildSvg({
        nodes,
        edges,
        zones,
        plan,
        inv,
        prefs: map.prefs,
        title: name.trim() || title,
        date: date ? new Date().toLocaleString() : null,
        legend,
        theme: probe,
      });
      const base = (name.trim() || title).replace(/[\\/:*?"<>|]+/g, "-");
      const path = await save({
        title: "Export map",
        defaultPath: `${base}.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (!path) return;
      const written = await ipc.mapExport(svg, format, Number(scale), path);
      useNotifications
        .getState()
        .notify({ variant: "success", title: "Map exported", description: written });
      close();
    } catch (err) {
      useNotifications.getState().notifyError(err, "Could not export the map");
    } finally {
      probe.remove();
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent
        title="Export map"
        description="PNG for chat and docs, SVG for editing, PDF (vector) for printing."
      >
        <form className="flex flex-col gap-4" onSubmit={(e) => void run(e)}>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-fg-muted">Format</span>
            <SegmentedControl
              label="Format"
              value={format}
              options={FORMATS}
              onChange={setFormat}
            />
          </div>
          {format === "png" && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-fg-muted">Scale</span>
              <SegmentedControl label="Scale" value={scale} options={SCALES} onChange={setScale} />
            </div>
          )}
          <Field label="Title">
            <Input placeholder={title} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center gap-2 text-[13px]">
              <Switch checked={legend} onCheckedChange={setLegend} aria-label="Legend" /> Legend
            </label>
            <label className="flex items-center gap-2 text-[13px]">
              <Switch checked={date} onCheckedChange={setDate} aria-label="Date" /> Date
            </label>
            <label className="flex items-center gap-2 text-[13px]">
              <Switch
                checked={light}
                onCheckedChange={setLight}
                aria-label="Light theme for printing"
              />{" "}
              Light theme
            </label>
            <label className="flex items-center gap-2 text-[13px]">
              <Switch
                checked={selectionOnly && selected.length > 0}
                disabled={selected.length === 0}
                onCheckedChange={setSelectionOnly}
                aria-label="Selection only"
              />
              Selection only{selected.length ? ` (${selected.length})` : ""}
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !canvas}>
              Export…
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
