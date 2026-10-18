import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { Channel } from "@tauri-apps/api/core";
import type {
  AuditEntry,
  ErrorPayload,
  PortInfo,
  PortsChanged,
  Settings,
  TerminalPrefs,
  TransferStatus,
  VaultStatus,
} from "@/lib/ipc";
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
  ports: PortInfo[] = [];
  /** Hotplug channel registered by `serial_ports_watch`. */
  portWatch: Channel<PortsChanged> | null = null;
  /** What the native open dialog returns. */
  dialogResult: string | string[] | null = null;

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

  /** Simulate plugging in (or removing) serial adapters. */
  hotplug(ports: PortInfo[]) {
    const before = this.ports;
    this.ports = ports;
    this.portWatch?.onmessage({
      ports,
      added: ports.filter((p) => !before.some((b) => b.path === p.path)),
      removed: before.filter((b) => !ports.some((p) => p.path === b.path)),
    });
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
      case "serial_ports":
        return this.ports;
      case "serial_ports_watch":
        this.portWatch = args.onChange as Channel<PortsChanged>;
        return this.ports;
      case "serial_ports_unwatch":
        this.portWatch = null;
        return null;
      case "serial_set_lines":
      case "session_break":
      case "serial_transfer_cancel":
        return null;
      case "serial_send_files": {
        const progress = args.onProgress as Channel<TransferStatus>;
        const files = (args.paths as string[]).map((p) => p.split("/").pop() ?? p);
        progress.onmessage({ phase: "running", bytes: 512, total: 1024 });
        this.log("file_transferred", { direction: "upload", file: files.join(", ") });
        return { phase: "done", files, bytes: 1024 };
      }
      case "serial_receive_files": {
        const progress = args.onProgress as Channel<TransferStatus>;
        progress.onmessage({ phase: "running", bytes: 2048, total: null });
        return [`${String(args.dir)}/fw.bin`];
      }
      case "plugin:dialog|open":
        return this.dialogResult;
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
