import { useEffect } from "react";
import { useActions, type Action } from "@/lib/actions";
import type { Device } from "@/lib/ipc";
import { useInventory } from "@/stores/inventory";
import { useUi } from "@/stores/ui";
import { connect, methodLabel } from "@/views/inventory/deviceActions";

/** Palette entries for every device: connect (default method) and show in inventory. */
export function deviceActions(devices: readonly Device[]): Action[] {
  return devices.flatMap((d) => {
    const keywords = [d.mgmtIp, d.model, d.vendor, ...d.tags].filter(Boolean);
    const first = d.connections[0];
    const out: Action[] = [
      {
        id: `device.show.${d.id}`,
        title: `Show ${d.hostname}`,
        group: "Devices",
        keywords: [...keywords, "inventory", "details"],
        run: () => {
          useUi.getState().setView("inventory");
          useInventory.getState().setSection("devices");
          useInventory.getState().setSheet({ mode: "view", deviceId: d.id });
        },
      },
    ];
    if (first && first.kind !== "rdp")
      out.unshift({
        id: `device.connect.${d.id}`,
        title: `Connect to ${d.hostname}`,
        group: "Devices",
        keywords: [...keywords, methodLabel(first), "ssh", "telnet", "console"],
        run: () => connect(d, 0),
      });
    return out;
  });
}

export function useDeviceActions() {
  const register = useActions((s) => s.register);
  const devices = useInventory((s) => s.snapshot?.devices);
  useEffect(() => (devices ? register(deviceActions(devices)) : undefined), [register, devices]);
}
