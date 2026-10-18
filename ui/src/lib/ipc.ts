import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { HighlightRuleSet } from "@/terminal/highlight/types";
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
/** Record an uncaught UI error in the app log (stderr). Never throws. */
export const logUiError = (message: string) => invoke("ui_log_error", { message }).catch(() => {});

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
  readOpensshKnownHosts: boolean;
  notifyOnDisconnect: boolean;
  sessionLogging: boolean;
  longCommandNotifySecs: number;
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

// ── Sessions ───────────────────────────────────────────────────────────────────────

export type CloseReason =
  { kind: "exited"; code: number | null } | { kind: "closed" } | { kind: "error"; message: string };

export interface HostKeyInfo {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  publicKey: string;
}

export type HostKeyStatus =
  | { status: "trusted" }
  | { status: "unknown" }
  | { status: "changed"; previousFingerprint: string };

export type SshPrompt =
  | { kind: "password"; user: string; target: string }
  | { kind: "passphrase"; key: string }
  | {
      kind: "keyboard_interactive";
      user: string;
      target: string;
      name: string;
      instructions: string;
      prompts: { text: string; echo: boolean }[];
    };

export type ConnectProgress =
  | { phase: "connecting"; index: number; target: string }
  | { phase: "authenticating"; index: number; user: string; target: string }
  | { phase: "connected"; host_key: HostKeyInfo | null };

export type SessionMessage =
  | { type: "closed"; reason: CloseReason }
  | { type: "connected" }
  | { type: "progress"; progress: ConnectProgress }
  | {
      type: "host_key";
      promptId: number;
      info: HostKeyInfo;
      status: HostKeyStatus;
      openssh: "match" | "mismatch" | "unknown";
    }
  | { type: "prompt"; promptId: number; prompt: SshPrompt };

/** Mirrors `cairn_pty::ShellSpec`. */
export interface ShellSpec {
  program?: string | null;
  args?: string[];
  cwd?: string | null;
  env?: [string, string][];
}

export interface Container {
  name: string;
  kind: "toolbox" | "distrobox" | "podman";
  image: string;
  running: boolean;
  /** Command that opens a shell inside the container. */
  spec: ShellSpec;
}

/** Header carrying the session id on `session_write` (see src-tauri commands/session.rs). */
export const SESSION_HEADER = "x-cairn-session";

function toBytes(payload: unknown): Uint8Array {
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (payload instanceof Uint8Array) return payload;
  if (Array.isArray(payload)) return Uint8Array.from(payload as number[]);
  return new Uint8Array();
}

export interface SessionCallbacks {
  /** Raw output bytes, in order. */
  onData: (bytes: Uint8Array) => void;
  onMessage: (msg: SessionMessage) => void;
}

function channels(cb: SessionCallbacks) {
  const onData = new Channel<ArrayBuffer>((payload) => cb.onData(toBytes(payload)));
  const onEvent = new Channel<SessionMessage>(cb.onMessage);
  return { onData, onEvent };
}

export const openLocalSession = (
  spec: ShellSpec | null,
  cols: number,
  rows: number,
  cb: SessionCallbacks,
) => call<string>("session_open_local", { spec, cols, rows, ...channels(cb) });

/** Send input as a raw binary body (no JSON encoding). */
export async function sessionWrite(id: string, data: Uint8Array): Promise<void> {
  try {
    await invoke("session_write", data, { headers: { [SESSION_HEADER]: id } });
  } catch (e) {
    throw CommandError.from(e);
  }
}

// ── SSH ────────────────────────────────────────────────────────────────────────────

export type LegacyAlgorithm =
  | "dh-group1-sha1"
  | "dh-group14-sha1"
  | "dh-gex-sha1"
  | "ssh-rsa-sha1"
  | "aes-cbc"
  | "triple-des-cbc"
  | "hmac-sha1";

export type AuthMethod =
  | { kind: "agent" }
  | { kind: "keyFile"; path: string; passphrase: string | null }
  | { kind: "keyboardInteractive" }
  | { kind: "password"; password: string | null };

export interface Hop {
  host: string;
  port: number;
  username: string;
  auth: AuthMethod[];
  algorithms: { legacy: LegacyAlgorithm[] };
}

export interface ProxyConfig {
  kind: "socks5" | "http";
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}

/** Mirrors `cairn_proto_ssh::ConnectOptions`. */
export interface ConnectOptions {
  hops: Hop[];
  proxy: ProxyConfig | null;
  keepaliveSecs: number;
  keepaliveMax: number;
  connectTimeoutSecs: number;
  agentForwarding: boolean;
}

export interface SshOpened {
  sessionId: string;
  connectionId: string;
}

export const sshOpen = (
  options: ConnectOptions,
  cols: number,
  rows: number,
  cb: SessionCallbacks,
) => call<SshOpened>("ssh_open", { options, cols, rows, ...channels(cb) });

export const sshReconnect = (
  connectionId: string,
  cols: number,
  rows: number,
  cb: SessionCallbacks,
) => call<string>("ssh_reconnect", { connectionId, cols, rows, ...channels(cb) });

export const sshForget = (connectionId: string) => call<null>("ssh_forget", { connectionId });

export type PromptAnswer =
  { kind: "hostKey"; accept: boolean } | { kind: "secrets"; values: string[] } | { kind: "cancel" };

export const sessionPromptReply = (promptId: number, answer: PromptAnswer) =>
  call<null>("session_prompt_reply", { promptId, answer });

export interface KnownHost extends HostKeyInfo {
  firstSeen: string;
  lastSeen: string;
}

export const knownHostsList = () => call<KnownHost[]>("known_hosts_list");
export const knownHostsRemove = (host: string, port: number, keyType: string) =>
  call<null>("known_hosts_remove", { host, port, keyType });

/** Send BREAK on a serial or Telnet session. */
export const sessionBreak = (id: string) => call<null>("session_break", { id });

// ── Serial ─────────────────────────────────────────────────────────────────────────

/** Mirrors `cairn_proto_serial::PortInfo`. */
export interface PortInfo {
  path: string;
  label: string;
  chip: string | null;
  vid: number | null;
  pid: number | null;
  serialNumber: string | null;
  usb: boolean;
}

export interface PortsChanged {
  ports: PortInfo[];
  added: PortInfo[];
  removed: PortInfo[];
}

export type DataBits = "five" | "six" | "seven" | "eight";
export type Parity = "none" | "odd" | "even";
export type StopBits = "one" | "two";
export type FlowControl = "none" | "rts-cts" | "xon-xoff";
export type Newline = "cr" | "lf" | "crlf";

export interface LineSettings {
  baud: number;
  dataBits: DataBits;
  parity: Parity;
  stopBits: StopBits;
  flowControl: FlowControl;
}

/** Mirrors `cairn_proto_serial::SerialOptions`. */
export interface SerialOptions {
  path: string;
  settings: LineSettings;
  newline: { transmit: Newline; receive: Newline };
  localEcho: boolean;
}

export type TransferVariant = "xmodem" | "xmodem1k" | "ymodem";

export type TransferStatus =
  | { phase: "running"; bytes: number; total: number | null }
  | { phase: "done"; files: string[]; bytes: number };

export const serialPorts = () => call<PortInfo[]>("serial_ports");

/** Current ports; `onChange` fires on hotplug until `serialPortsUnwatch`. */
export const serialPortsWatch = (onChange: (c: PortsChanged) => void) =>
  call<PortInfo[]>("serial_ports_watch", { onChange: new Channel<PortsChanged>(onChange) });

export const serialPortsUnwatch = () => call<null>("serial_ports_unwatch");

export const serialOpen = (options: SerialOptions, cb: SessionCallbacks) =>
  call<string>("serial_open", { options, ...channels(cb) });

export const serialSetLines = (id: string, lines: { dtr?: boolean; rts?: boolean }) =>
  call<null>("serial_set_lines", { id, dtr: lines.dtr ?? null, rts: lines.rts ?? null });

export const serialSendFiles = (
  id: string,
  variant: TransferVariant,
  paths: string[],
  onProgress: (s: TransferStatus) => void,
) =>
  call<TransferStatus>("serial_send_files", {
    id,
    variant,
    paths,
    onProgress: new Channel<TransferStatus>(onProgress),
  });

/** Receive into `dir`; resolves with the saved file paths. */
export const serialReceiveFiles = (
  id: string,
  variant: TransferVariant,
  dir: string,
  onProgress: (s: TransferStatus) => void,
) =>
  call<string[]>("serial_receive_files", {
    id,
    variant,
    dir,
    onProgress: new Channel<TransferStatus>(onProgress),
  });

export const serialTransferCancel = (id: string) => call<null>("serial_transfer_cancel", { id });

// ── Telnet ─────────────────────────────────────────────────────────────────────────

export type ConsoleServerKind =
  "opengear" | "cisco-line" | "avocent" | "lantronix" | "digi" | "custom";

/** Mirrors `TelnetRequest` in src-tauri commands/telnet.rs. */
export interface TelnetRequest {
  host: string;
  port: number;
  raw: boolean;
  console: { kind: ConsoleServerKind; port: number } | null;
  connectTimeoutSecs: number;
}

export const telnetOpen = (
  request: TelnetRequest,
  cols: number,
  rows: number,
  cb: SessionCallbacks,
) => call<string>("telnet_open", { request, cols, rows, ...channels(cb) });

export const sessionResize = (id: string, cols: number, rows: number) =>
  call<null>("session_resize", { id, cols, rows });
export const sessionClose = (id: string) => call<null>("session_close", { id });
export const localContainers = () => call<Container[]>("local_containers");
export const localDefaultShell = () => call<string>("local_default_shell");

// ── Terminal preferences ───────────────────────────────────────────────────────────

export interface TerminalProfile {
  id: string;
  name: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
  scrollback: number;
  /** null follows the app theme. */
  paletteId: string | null;
  opacity: number;
  bell: "none" | "visual" | "sound";
  copyOnSelect: boolean;
  pasteLineDelayMs: number;
  shell: string | null;
}

export interface CustomPaletteDto {
  id: string;
  name: string;
  scheme: "dark" | "light";
  source: string;
  license: string;
  colors: Record<string, string>;
}

export interface TerminalPrefs {
  profiles: TerminalProfile[];
  defaultProfileId: string;
  customPalettes: CustomPaletteDto[];
  privilegedPromptPatterns: string[];
  confirmMultilinePaste: boolean;
  highlightEnabled: boolean;
  /** User-edited/added sets; replace built-in sets with the same id. */
  highlightSets: HighlightRuleSet[];
}

export const terminalPrefsGet = () => call<TerminalPrefs>("terminal_prefs_get");
export const terminalPrefsUpdate = (prefs: TerminalPrefs) =>
  call<TerminalPrefs>("terminal_prefs_update", { prefs });
