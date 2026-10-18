import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

let permission: Promise<boolean> | null = null;

async function allowed(): Promise<boolean> {
  permission ??= (async () => {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  })().catch(() => false);
  return permission;
}

/** Desktop notification; silently skipped when not permitted or unavailable. */
export async function desktopNotify(title: string, body: string): Promise<void> {
  try {
    if (await allowed()) sendNotification({ title, body });
  } catch {
    // Notifications are best-effort.
  }
}
