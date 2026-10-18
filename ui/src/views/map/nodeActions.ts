import type { Device } from "@/lib/ipc";
import { useInventory } from "@/stores/inventory";
import { useUi } from "@/stores/ui";
import { openLocalShell } from "@/terminal/controller";

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
