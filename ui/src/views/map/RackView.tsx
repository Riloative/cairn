import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/cn";
import * as ipc from "@/lib/ipc";
import type { Device, InventorySnapshot, Rack } from "@/lib/ipc";
import { Glyph } from "@/map/Glyph";
import { fits, rackTop, U_PX } from "@/map/rack";
import { RACK_BODY, RACK_DEVICE, RackFace, RackUnits } from "@/map/RackElevation";
import { Rows3 } from "lucide-react";
import { useInventory } from "@/stores/inventory";
import { useUi } from "@/stores/ui";
import { connect } from "@/views/inventory/deviceActions";
import { mutate } from "@/views/inventory/mutate";

interface Drag {
  device: Device;
  /** Pointer offset from the device's top edge, in px. */
  grabY: number;
  target: { rackId: number; u: number; ok: boolean } | null;
}

async function place(d: Device, rackId: number, u: number) {
  await mutate(() => ipc.deviceSave({ ...d, rackId, rackU: u }), {
    error: `Could not move ${d.hostname}`,
  });
}

/** Front elevation of every rack on a floor; drag devices to (re)rack them. */
export function RackView({ floorId, inv }: { floorId: number; inv: InventorySnapshot }) {
  const racks = useMemo(() => inv.racks.filter((r) => r.floorId === floorId), [inv.racks, floorId]);
  const onFloor = useMemo(
    () => inv.devices.filter((d) => d.floorId === floorId),
    [inv.devices, floorId],
  );
  const unracked = onFloor.filter((d) => d.rackId === null || d.rackU === null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const columns = useRef(new Map<number, HTMLDivElement>());

  function targetAt(clientX: number, clientY: number, d: Drag): Drag["target"] {
    for (const rack of racks) {
      const el = columns.current.get(rack.id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (clientX < r.left || clientX > r.right) continue;
      // Top of the dragged block → its highest U; rack U1 is at the bottom.
      const topY = clientY - d.grabY - r.top;
      const topU = rack.heightU - Math.round(topY / U_PX);
      const u = topU - d.device.uHeight + 1;
      return { rackId: rack.id, u, ok: fits(rack, inv.devices, u, d.device.uHeight, d.device.id) };
    }
    return null;
  }

  function start(e: PointerEvent, device: Device) {
    if (e.button !== 0) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ device, grabY: e.clientY - rect.top, target: null });
  }

  function move(e: PointerEvent) {
    if (!drag) return;
    setDrag({ ...drag, target: targetAt(e.clientX, e.clientY, drag) });
  }

  function end() {
    const d = drag;
    setDrag(null);
    if (d?.target?.ok && (d.target.rackId !== d.device.rackId || d.target.u !== d.device.rackU))
      void place(d.device, d.target.rackId, d.target.u);
  }

  function nudge(e: KeyboardEvent, d: Device, rack: Rack) {
    if (e.key === "Enter") {
      useUi.getState().setView("inventory");
      useInventory.getState().setSheet({ mode: "view", deviceId: d.id });
      return;
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const u = (d.rackU ?? 1) + (e.key === "ArrowUp" ? 1 : -1);
    if (fits(rack, inv.devices, u, d.uHeight, d.id)) void place(d, rack.id, u);
  }

  if (racks.length === 0) {
    return (
      <EmptyState
        icon={<Rows3 size={20} />}
        title="No racks on this floor"
        description="Add racks under Inventory → Locations, then place devices by dragging them here."
      />
    );
  }

  return (
    <div
      className="flex h-full min-h-0 gap-6 overflow-auto p-6"
      onPointerMove={move}
      onPointerUp={end}
    >
      {racks.map((rack) => {
        const room = inv.rooms.find((r) => r.id === rack.roomId);
        const devices = inv.devices.filter((d) => d.rackId === rack.id && d.rackU !== null);
        const used = devices.reduce((n, d) => n + d.uHeight, 0);
        const preview = drag?.target?.rackId === rack.id ? drag.target : null;
        return (
          <section
            key={rack.id}
            aria-label={`Rack ${rack.name}`}
            className="flex shrink-0 flex-col gap-2"
          >
            <header className="flex items-baseline gap-2">
              <h3 className="text-[13px] font-semibold">{rack.name}</h3>
              <span className="text-xs text-fg-subtle">
                {[room?.name, `${used}/${rack.heightU} U`].filter(Boolean).join(" · ")}
              </span>
            </header>
            <div className="flex">
              <RackUnits heightU={rack.heightU} />
              <div
                ref={(el) => {
                  if (el) columns.current.set(rack.id, el);
                  else columns.current.delete(rack.id);
                }}
                className={cn(RACK_BODY, "w-64")}
                style={{ height: rack.heightU * U_PX }}
              >
                {devices.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    aria-label={`${d.hostname}, U${d.rackU}${d.uHeight > 1 ? `–U${(d.rackU ?? 0) + d.uHeight - 1}` : ""}`}
                    onPointerDown={(e) => start(e, d)}
                    onDoubleClick={() => connect(d)}
                    onKeyDown={(e) => nudge(e, d, rack)}
                    className={cn(
                      RACK_DEVICE,
                      "cursor-grab hover:border-accent focus-visible:border-accent focus-visible:outline-none",
                      drag?.device.id === d.id && "opacity-40",
                    )}
                    style={{
                      top: rackTop(rack, d.rackU ?? 1, d.uHeight) + 1,
                      height: d.uHeight * U_PX - 2,
                    }}
                  >
                    <RackFace device={d} />
                  </button>
                ))}
                {preview && drag && (
                  <div
                    aria-hidden
                    className={cn(
                      "pointer-events-none absolute inset-x-0.5 rounded-sm border-2 border-dashed",
                      preview.ok ? "border-success bg-success/10" : "border-danger bg-danger/10",
                    )}
                    style={{
                      top: rackTop(rack, preview.u, drag.device.uHeight),
                      height: drag.device.uHeight * U_PX,
                    }}
                  />
                )}
              </div>
            </div>
          </section>
        );
      })}
      <aside aria-label="Not racked" className="flex w-56 shrink-0 flex-col gap-2">
        <h3 className="text-[13px] font-semibold">Not racked</h3>
        {unracked.length === 0 ? (
          <p className="text-xs text-fg-subtle">Every device on this floor is in a rack.</p>
        ) : (
          unracked.map((d) => (
            <button
              key={d.id}
              type="button"
              onPointerDown={(e) => start(e, d)}
              className={cn(
                "flex cursor-grab items-center gap-2 rounded-md border border-border bg-surface-raised px-2 text-left text-xs",
                drag?.device.id === d.id && "opacity-40",
              )}
              style={{ height: d.uHeight * U_PX }}
            >
              <Glyph type={d.deviceType} size={14} className="text-fg-muted" />
              <span className="truncate font-medium">{d.hostname}</span>
              <span className="ml-auto text-[10px] text-fg-subtle">{d.uHeight}U</span>
            </button>
          ))
        )}
        <p className="text-xs text-fg-subtle">
          Drag a device onto a rack. Arrow keys move a racked device by 1U.
        </p>
      </aside>
    </div>
  );
}
