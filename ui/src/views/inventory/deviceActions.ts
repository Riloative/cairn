import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import * as ipc from "@/lib/ipc";
import type { ConnectionMethod, Device } from "@/lib/ipc";
import { confirmAction } from "@/stores/confirm";
import { useInventory } from "@/stores/inventory";
import { useNotifications } from "@/stores/notifications";
import { useUi } from "@/stores/ui";
import { openRdpDevice } from "@/rdp/controller";
import { openDevice } from "@/terminal/controller";
import { methodError } from "./model";
import { mutate } from "./mutate";

/** Label for a connection method in menus. */
export function methodLabel(m: ConnectionMethod): string {
  switch (m.kind) {
    case "ssh":
      return m.port === 22 ? "SSH" : `SSH (port ${m.port})`;
    case "telnet":
      return m.raw ? `Raw TCP ${m.port}` : m.port === 23 ? "Telnet" : `Telnet (port ${m.port})`;
    case "serial":
      return `Serial ${m.path.split("/").pop() ?? m.path}`;
    case "console-server":
      return `Console ${m.host} port ${m.port}`;
    case "rdp":
      return "RDP";
    case "web":
      return "Web UI";
  }
}

/** Whether a method can be opened: its settings are complete. */
export function canOpen(m: ConnectionMethod): boolean {
  return methodError(m) === undefined;
}

/** Open a connection method: a terminal tab, or the browser for web UIs. */
export function connect(device: Device, index = 0) {
  const m = device.connections[index];
  if (!m) {
    useNotifications.getState().notify({
      variant: "warning",
      title: `${device.hostname} has no connection methods`,
      description: "Edit the device and add SSH, Telnet, serial, a console server or RDP.",
    });
    return;
  }
  if (m.kind === "web") {
    openUrl(m.url).catch((e: unknown) =>
      useNotifications.getState().notifyError(e, "Could not open the web UI"),
    );
    return;
  }
  if (m.kind === "rdp") {
    if (m.external) {
      ipc.rdpExternal(device.id, index).then(
        (what) =>
          useNotifications
            .getState()
            .notify({ variant: "success", title: `${device.hostname}: ${what}` }),
        (e: unknown) => useNotifications.getState().notifyError(e, "Could not open the RDP client"),
      );
      return;
    }
    useUi.getState().setView("sessions");
    openRdpDevice(device, index, m);
    return;
  }
  useUi.getState().setView("sessions");
  void openDevice(device, index);
}

export async function copyIp(device: Device) {
  if (!device.mgmtIp) return;
  try {
    await writeText(device.mgmtIp);
    useNotifications.getState().notify({ variant: "success", title: `Copied ${device.mgmtIp}` });
  } catch (e) {
    useNotifications.getState().notifyError(e, "Could not copy");
  }
}

export async function duplicateDevice(device: Device) {
  const result = await mutate(() => ipc.deviceDuplicate(device.id), {
    error: `Could not duplicate ${device.hostname}`,
  });
  if (result) useInventory.getState().setSheet({ mode: "edit", deviceId: result.device.id });
}

export async function deleteDevice(device: Device) {
  const ok = await confirmAction({
    title: `Delete ${device.hostname}?`,
    description: `The device and its ${device.interfaceCount} interfaces are removed. This is recorded in the audit log.`,
    confirmLabel: "Delete device",
    destructive: true,
  });
  if (!ok) return;
  const done = await mutate(() => ipc.deviceDelete(device.id), {
    error: `Could not delete ${device.hostname}`,
  });
  if (done !== undefined) {
    const sheet = useInventory.getState().sheet;
    if (sheet && sheet.mode !== "new" && sheet.deviceId === device.id)
      useInventory.getState().setSheet(null);
  }
}
