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
