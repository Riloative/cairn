import * as ipc from "@/lib/ipc";
import type { Device, GrabResult } from "@/lib/ipc";
import { create } from "zustand";
import { useInventory } from "@/stores/inventory";
import { useNotifications } from "@/stores/notifications";
import { useSessions } from "@/stores/sessions";
import { useUi } from "@/stores/ui";
import { backendSessionId, openDevice } from "@/terminal/controller";

/** Devices with a grab in progress, and a counter that bumps when history changes. */
interface GrabState {
  running: number[];
  version: number;
}

export const useGrab = create<GrabState>(() => ({ running: [], version: 0 }));

const CONNECT_TIMEOUT_MS = 120_000;

/** A connected SSH tab of the device, as its backend session id. */
function connectedSession(deviceId: number): string | undefined {
  for (const t of useSessions.getState().tabs) {
    if (t.device?.id !== deviceId || t.protocol !== "ssh" || t.state !== "connected") continue;
    const id = backendSessionId(t.id);
    if (id) return id;
  }
  return undefined;
}

/** Resolves when the tab is connected; rejects if it fails or takes too long. */
function waitConnected(tabId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error("The connection did not come up within 2 minutes."));
    }, CONNECT_TIMEOUT_MS);
    const check = () => {
      const tab = useSessions.getState().tabs.find((t) => t.id === tabId);
      const id = backendSessionId(tabId);
      if (tab?.state === "connected" && id) {
        clearTimeout(timer);
        unsub();
        resolve(id);
      } else if (!tab || tab.state === "error" || tab.state === "disconnected") {
        clearTimeout(timer);
        unsub();
        reject(new Error(tab?.detail ?? "The session closed before it connected."));
      }
    };
    const unsub = useSessions.subscribe(check);
    check();
  });
}

/**
 * Grab a device's configuration over SSH: reuses a connected SSH tab of the device,
 * or opens one (prompts appear there as usual) and grabs once it is connected.
 */
export async function grabConfig(device: Device): Promise<GrabResult | null> {
  const notifications = useNotifications.getState();
  const ssh = device.connections.findIndex((m) => m.kind === "ssh");
  if (ssh < 0) {
    notifications.notify({
      variant: "warning",
      title: `${device.hostname} has no SSH connection`,
      description: "Grab config runs the show command over SSH. Add an SSH connection method.",
    });
    return null;
  }
  if (useGrab.getState().running.includes(device.id)) return null;
  useGrab.setState({ running: [...useGrab.getState().running, device.id] });
  try {
    let sessionId = connectedSession(device.id);
    if (!sessionId) {
      useUi.getState().setView("sessions");
      const tabId = await openDevice(device, ssh);
      sessionId = await waitConnected(tabId);
    }
    const result = await ipc.configGrab(device.id, sessionId);
    notifications.notify({
      variant: "success",
      title: `Saved the configuration of ${device.hostname}`,
      description: result.changed
        ? `${result.snapshot.lines} lines, changed since the last snapshot.`
        : "Unchanged since the last snapshot.",
      action: {
        label: "Show history",
        onClick: () => {
          useUi.getState().setView("inventory");
          useInventory.getState().setSection("devices");
          useInventory.getState().setSheet({ mode: "view", deviceId: device.id, tab: "configs" });
        },
      },
    });
    return result;
  } catch (e) {
    notifications.notifyError(e, `Could not grab the configuration of ${device.hostname}`);
    return null;
  } finally {
    useGrab.setState((s) => ({
      running: s.running.filter((id) => id !== device.id),
      version: s.version + 1,
    }));
  }
}
