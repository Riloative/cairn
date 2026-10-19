import type { Device, Rack } from "@/lib/ipc";

/** Pixel height of one rack unit. */
export const U_PX = 20;

/** Whether `[u, u+h)` fits in `rack` without overlapping other devices. */
export function fits(
  rack: Rack,
  devices: readonly Device[],
  u: number,
  h: number,
  ignore: number,
): boolean {
  if (u < 1 || u + h - 1 > rack.heightU) return false;
  return !devices.some(
    (d) =>
      d.id !== ignore &&
      d.rackId === rack.id &&
      d.rackU !== null &&
      d.rackU <= u + h - 1 &&
      d.rackU + d.uHeight - 1 >= u,
  );
}

/** Top offset (px) of a device whose lowest unit is `rackU`; U1 is at the bottom. */
export function rackTop(rack: Rack, rackU: number, uHeight: number): number {
  return (rack.heightU - (rackU + uHeight - 1)) * U_PX;
}

/** The devices mounted in `rack`, sorted top to bottom. */
export function mountedIn(rack: Rack, devices: readonly Device[]): Device[] {
  return devices
    .filter((d) => d.rackId === rack.id && d.rackU !== null)
    .sort((a, b) => (b.rackU ?? 0) - (a.rackU ?? 0));
}
