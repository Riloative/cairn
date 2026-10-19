import type { Device } from "@/lib/ipc";
import { useBroadcast } from "@/stores/broadcast";
import { useInventory } from "@/stores/inventory";
import { useNotifications } from "@/stores/notifications";
import { useUi } from "@/stores/ui";
import { openDevice, openLocalShell } from "@/terminal/controller";

/** The address diagnostics use: management IP, else hostname. */
export function target(d: Device): string {
  return d.mgmtIp || d.hostname;
}

/**
 * Run a diagnostic in a local terminal tab. The address is passed as a positional
 * argument (never interpolated into the script); after the command ends (Ctrl+C for
 * ping) the tab drops into the user's shell so the output stays readable.
 */
function diagnostic(d: Device, script: string, title: string) {
  useUi.getState().setView("sessions");
  void openLocalShell(
    {
      program: "/bin/sh",
      args: ["-c", `${script}; exec "\${SHELL:-/bin/sh}"`, "cairn", target(d)],
    },
    `${title} ${d.hostname}`,
  );
}

export function ping(d: Device) {
  diagnostic(d, 'ping "$1"', "ping");
}

export function traceroute(d: Device) {
  diagnostic(
    d,
    'if command -v traceroute >/dev/null 2>&1; then traceroute "$1"; else tracepath "$1"; fi',
    "traceroute",
  );
}

export function showInInventory(d: Device, edit = false) {
  useUi.getState().setView("inventory");
  useInventory.getState().setSection("devices");
  useInventory
    .getState()
    .setSheet(edit ? { mode: "edit", deviceId: d.id } : { mode: "view", deviceId: d.id });
}

/** Devices whose first connection method opens a terminal (SSH, Telnet, serial). */
export function terminalDevices(devices: readonly Device[]): Device[] {
  return devices.filter((d) => {
    const kind = d.connections[0]?.kind;
    return kind !== undefined && kind !== "web" && kind !== "rdp";
  });
}

/**
 * Open a session to each device (its default method) and, with `broadcast`, start
 * broadcasting input to all of them.
 */
export async function openSessions(devices: readonly Device[], broadcast: boolean) {
  const usable = terminalDevices(devices);
  if (usable.length === 0) {
    useNotifications.getState().notify({
      variant: "info",
      title: "No terminal connections",
      description: "None of the selected devices has SSH, Telnet or a serial connection.",
    });
    return;
  }
  useUi.getState().setView("sessions");
  const tabs = await Promise.all(usable.map((d) => openDevice(d, 0)));
  if (broadcast && tabs.length >= 2) useBroadcast.getState().start(tabs);
}
