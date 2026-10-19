import type { Device, Rack } from "@/lib/ipc";
import { cn } from "@/lib/cn";
import { Glyph } from "./Glyph";
import { mountedIn, rackTop, U_PX } from "./rack";

/** Rack unit numbers, U1 at the bottom, aligned with the rack body. */
export function RackUnits({ heightU }: { heightU: number }) {
  return (
    <ol
      aria-hidden
      className="mr-1 flex flex-col-reverse text-right font-mono text-[9px] text-fg-subtle"
    >
      {Array.from({ length: heightU }, (_, i) => (
        <li key={i} style={{ height: U_PX }} className="leading-[20px]">
          {i + 1}
        </li>
      ))}
    </ol>
  );
}

/** Classes for the rack body: rails on both sides and a faint line per unit. */
export const RACK_BODY =
  "relative rounded-md border-2 border-border-strong bg-bg-subtle " +
  "bg-[repeating-linear-gradient(to_bottom,transparent_0,transparent_19px,var(--border)_19px,var(--border)_20px)] " +
  "before:absolute before:inset-y-0 before:left-0 before:w-2 before:border-r before:border-border " +
  "after:absolute after:inset-y-0 after:right-0 after:w-2 after:border-l after:border-border";

/** The front panel of a mounted device: ears, icon, name, address and size. */
export function RackFace({ device, compact = false }: { device: Device; compact?: boolean }) {
  const tall = device.uHeight > 1;
  return (
    <>
      <span aria-hidden className="flex h-full w-2 shrink-0 flex-col justify-center gap-1">
        <span className="mx-auto size-1 rounded-full bg-fg-subtle/60" />
        {tall && <span className="mx-auto size-1 rounded-full bg-fg-subtle/60" />}
      </span>
      <Glyph type={device.deviceType} size={14} className="shrink-0 text-fg-muted" />
      <span className={cn("flex min-w-0 flex-1", tall ? "flex-col" : "items-baseline gap-2")}>
        <span className="truncate font-medium">{device.hostname}</span>
        {!compact && device.mgmtIp && (
          <span className="truncate font-mono text-[10px] text-fg-subtle">{device.mgmtIp}</span>
        )}
      </span>
      <span className="shrink-0 text-[10px] text-fg-subtle">{device.uHeight}U</span>
      <span aria-hidden className="flex h-full w-2 shrink-0 flex-col justify-center gap-1">
        <span className="mx-auto size-1 rounded-full bg-fg-subtle/60" />
        {tall && <span className="mx-auto size-1 rounded-full bg-fg-subtle/60" />}
      </span>
    </>
  );
}

/** Classes for a device block positioned inside the rack body. */
export const RACK_DEVICE =
  "absolute inset-x-0 z-10 flex items-center gap-2 rounded-[3px] border border-border-strong " +
  "bg-surface-raised px-0.5 text-left text-xs shadow-sm";

/**
 * Read-only front elevation of one rack with the devices mounted in it. Clicking a
 * device calls `onOpen` (e.g. to show its details).
 */
export function RackElevation({
  rack,
  devices,
  onOpen,
  className,
}: {
  rack: Rack;
  devices: readonly Device[];
  onOpen?: (device: Device) => void;
  className?: string;
}) {
  const mounted = mountedIn(rack, devices);
  return (
    <figure aria-label={`Rack ${rack.name} elevation`} className={cn("flex", className)}>
      <RackUnits heightU={rack.heightU} />
      <div className={cn(RACK_BODY, "w-72")} style={{ height: rack.heightU * U_PX }}>
        {mounted.map((d) => (
          <button
            key={d.id}
            type="button"
            aria-label={`${d.hostname}, U${d.rackU}${d.uHeight > 1 ? `–U${(d.rackU ?? 0) + d.uHeight - 1}` : ""}`}
            onClick={() => onOpen?.(d)}
            className={cn(
              RACK_DEVICE,
              "hover:border-accent focus-visible:border-accent focus-visible:outline-none",
            )}
            style={{
              top: rackTop(rack, d.rackU ?? 1, d.uHeight) + 1,
              height: d.uHeight * U_PX - 2,
            }}
          >
            <RackFace device={d} />
          </button>
        ))}
        {mounted.length === 0 && (
          <figcaption className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-fg-subtle">
            Empty. Set a device's rack and U in its details, or drag it here in the map's rack view.
          </figcaption>
        )}
      </div>
    </figure>
  );
}
