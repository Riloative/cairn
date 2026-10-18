import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ThemeId, ThemeSetting } from "./theme";

/**
 * Typed wrappers around Tauri commands. Components never call `invoke` directly, so the
 * IPC surface stays in one auditable place and mirrors `src-tauri/src/commands`.
 */

/** Error payload returned by every command (`CommandError` in src-tauri/src/error.rs). */
export interface ErrorPayload {
  code: string;
  message: string;
  hint: string | null;
}

/** A failed command, carrying the backend's user-facing message and hint. */
export class CommandError extends Error {
  readonly code: string;
  readonly hint: string | null;

  constructor(payload: ErrorPayload) {
    super(payload.message);
    this.name = "CommandError";
    this.code = payload.code;
    this.hint = payload.hint;
  }

  static from(err: unknown): CommandError {
    if (err instanceof CommandError) return err;
    if (typeof err === "object" && err !== null && "code" in err && "message" in err) {
      const p = err as Partial<ErrorPayload>;
      return new CommandError({
        code: String(p.code),
        message: String(p.message),
        hint: p.hint ?? null,
      });
    }
    return new CommandError({ code: "internal", message: String(err), hint: null });
  }
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw CommandError.from(e);
  }
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// ── App ────────────────────────────────────────────────────────────────────────────

export interface AppInfo {
  name: string;
  version: string;
  os: string;
  arch: string;
}

export const getAppInfo = () => call<AppInfo>("app_info");

// ── Vault ──────────────────────────────────────────────────────────────────────────

export type VaultStatus = "uninitialized" | "locked" | "unlocked";
export type LockReason = "manual" | "idle" | "system_sleep";

export interface VaultInfo {
  status: VaultStatus;
  failedAttempts: number;
  minPasswordLength: number;
}

export const vaultStatus = () => call<VaultInfo>("vault_status");
export const vaultSetup = (password: string) => call<VaultInfo>("vault_setup", { password });
export const vaultUnlock = (password: string) => call<VaultInfo>("vault_unlock", { password });
export const vaultLock = () => call<VaultInfo>("vault_lock");
export const vaultChangePassword = (current: string, next: string) =>
  call<null>("vault_change_password", { current, new: next });
export const activityPing = () => call<null>("activity_ping");

export function onVaultLocked(handler: (reason: LockReason) => void): Promise<UnlistenFn> {
  return listen<LockReason>("vault://locked", (e) => handler(e.payload));
}

// ── Settings ───────────────────────────────────────────────────────────────────────

/** Mirrors `cairn_core::settings::Settings` (camelCase). */
export interface Settings {
  theme: ThemeSetting;
  systemDarkTheme: ThemeId;
  systemLightTheme: ThemeId;
  autoLockMinutes: number;
  lockOnSleep: boolean;
  sidebarCollapsed: boolean;
  reduceMotion: boolean;
}

export const settingsGet = () => call<Settings>("settings_get");
export const settingsUpdate = (settings: Settings) =>
  call<Settings>("settings_update", { settings });

// ── Audit ──────────────────────────────────────────────────────────────────────────

export interface AuditEntry {
  seq: number;
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface IntegrityReport {
  ok: boolean;
  entries: number;
  firstBadSeq: number | null;
}

export const auditRecent = (limit: number) => call<AuditEntry[]>("audit_recent", { limit });
export const auditVerify = () => call<IntegrityReport>("audit_verify");
