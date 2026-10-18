import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { AuditEntry, ErrorPayload, Settings, TerminalPrefs, VaultStatus } from "@/lib/ipc";
import { DEFAULT_TERMINAL_PREFS } from "@/stores/terminalPrefs";

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  systemDarkTheme: "midnight",
  systemLightTheme: "paper",
  autoLockMinutes: 15,
  lockOnSleep: true,
  sidebarCollapsed: false,
  reduceMotion: false,
  readOpensshKnownHosts: true,
  notifyOnDisconnect: true,
  sessionLogging: false,
  longCommandNotifySecs: 10,
};

/**
 * In-memory stand-in for the Rust backend, wired through Tauri's official IPC mock. It
 * mirrors the command contract in src-tauri/src/commands so UI flows can be tested.
 */
export class FakeBackend {
  status: VaultStatus;
  password = "correct horse battery";
  failedAttempts = 0;
  settings: Settings = { ...DEFAULT_SETTINGS };
  terminalPrefs: TerminalPrefs = structuredClone(DEFAULT_TERMINAL_PREFS);
  audit: AuditEntry[] = [];
  calls: { cmd: string; args: Record<string, unknown> }[] = [];

  constructor(status: VaultStatus) {
    this.status = status;
    mockIPC((cmd, args) => this.handle(cmd, (args ?? {}) as Record<string, unknown>), {
      shouldMockEvents: true,
    });
  }

  dispose() {
    clearMocks();
  }

  /** Simulate the backend auto-locking (idle or sleep). */
  async autoLock(reason: "idle" | "system_sleep") {
    this.status = "locked";
    await emit("vault://locked", reason);
  }

  private info() {
    return { status: this.status, failedAttempts: this.failedAttempts, minPasswordLength: 10 };
  }

  private fail(payload: ErrorPayload): never {
    throw payload;
  }

  private log(kind: string, payload: Record<string, unknown> = {}) {
    const seq = this.audit.length + 1;
    this.audit.unshift({
      seq,
      ts: new Date().toISOString(),
      kind,
      payload: { kind, ...payload },
      prevHash: "0".repeat(64),
      hash: String(seq).padStart(64, "0"),
    });
  }

  private requireUnlocked() {
    if (this.status !== "unlocked")
      this.fail({ code: "vault.locked", message: "Cairn is locked.", hint: null });
  }

  handle(cmd: string, args: Record<string, unknown>): unknown {
    this.calls.push({ cmd, args });
    switch (cmd) {
      case "app_info":
        return { name: "Cairn", version: "0.1.0", os: "linux", arch: "x86_64" };
      case "vault_status":
        return this.info();
      case "vault_setup":
        this.password = String(args.password);
        this.status = "unlocked";
        this.log("vault_created");
        this.log("app_unlocked");
        return this.info();
      case "vault_unlock":
        if (args.password !== this.password) {
          this.failedAttempts += 1;
          this.fail({
            code: "vault.wrong_password",
            message: "The master password is incorrect.",
            hint: "Check Caps Lock and keyboard layout.",
          });
        }
        this.failedAttempts = 0;
        this.status = "unlocked";
        this.log("app_unlocked");
        return this.info();
      case "vault_lock":
        this.status = "locked";
        this.log("app_locked", { reason: "manual" });
        return this.info();
      case "vault_change_password":
        if (args.current !== this.password)
          this.fail({
            code: "vault.wrong_password",
            message: "The master password is incorrect.",
            hint: null,
          });
        this.password = String(args.new);
        return null;
      case "activity_ping":
        return null;
      case "settings_get":
        this.requireUnlocked();
        return this.settings;
      case "settings_update":
        this.requireUnlocked();
        this.settings = args.settings as Settings;
        this.log("settings_changed", { changes: [] });
        return this.settings;
      case "terminal_prefs_get":
        this.requireUnlocked();
        return this.terminalPrefs;
      case "terminal_prefs_update":
        this.requireUnlocked();
        this.terminalPrefs = args.prefs as TerminalPrefs;
        this.log("settings_changed", { changes: [] });
        return this.terminalPrefs;
      case "local_containers":
      case "known_hosts_list":
        return [];
      case "audit_recent":
        this.requireUnlocked();
        return this.audit.slice(0, Number(args.limit));
      case "audit_verify":
        this.requireUnlocked();
        return { ok: true, entries: this.audit.length, firstBadSeq: null };
      default:
        throw new Error(`FakeBackend: unhandled command ${cmd}`);
    }
  }
}
