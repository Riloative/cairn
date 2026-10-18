import { invoke } from "@tauri-apps/api/core";

/**
 * Typed wrappers around Tauri commands. Components never call `invoke` directly, so the
 * IPC surface stays in one auditable place and mirrors `src-tauri/src/commands`.
 */

export interface AppInfo {
  name: string;
  version: string;
  os: string;
  arch: string;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function getAppInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("app_info");
}
