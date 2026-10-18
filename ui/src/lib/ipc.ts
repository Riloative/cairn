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

// ── Inventory ──────────────────────────────────────────────────────────────────────

export interface Site {
  id: number;
  name: string;
  notes: string;
}

export interface Building {
  id: number;
  siteId: number;
  name: string;
  code: string;
  address: string;
  notes: string;
}

export interface Floor {
  id: number;
  buildingId: number;
  name: string;
  level: number;
  notes: string;
}

export interface Room {
  id: number;
  floorId: number;
  name: string;
  notes: string;
}

export interface Rack {
  id: number;
  floorId: number;
  roomId: number | null;
  name: string;
  heightU: number;
  notes: string;
}

export type LocationKind = "site" | "building" | "floor" | "room" | "rack";

export type LocationInput =
  | ({ kind: "site" } & Site)
  | ({ kind: "building" } & Building)
  | ({ kind: "floor" } & Floor)
  | ({ kind: "room" } & Room)
  | ({ kind: "rack" } & Rack);

export type DeviceType =
  | "switch"
  | "router"
  | "firewall"
  | "server"
  | "access-point"
  | "wireless-controller"
  | "storage"
  | "hypervisor"
  | "pdu"
  | "ups"
  | "patch-panel"
  | "camera"
  | "ip-phone"
  | "generic";

/** Mirrors `cairn_core::inventory::ConnectionMethod`. The first one is the default. */
export type ConnectionMethod =
  | {
      kind: "ssh";
      port: number;
      username: string;
      legacy: LegacyAlgorithm[];
      jumps: string;
      agentForwarding: boolean;
    }
  | { kind: "telnet"; port: number; raw: boolean }
  | {
      kind: "serial";
      path: string;
      settings: LineSettings;
      newline: { transmit: Newline; receive: Newline };
      localEcho: boolean;
    }
  | { kind: "console-server"; host: string; server: ConsoleServerKind; port: number; raw: boolean }
  | { kind: "rdp"; port: number; username: string }
  | { kind: "web"; url: string };

export type CustomValue = string | number | boolean | string[] | null;

export interface Device {
  id: number;
  hostname: string;
  mgmtIp: string;
  deviceType: DeviceType;
  vendor: string;
  model: string;
  serial: string;
  firmware: string;
  buildingId: number | null;
  floorId: number | null;
  roomId: number | null;
  rackId: number | null;
  rackU: number | null;
  uHeight: number;
  credentialId: number | null;
  connections: ConnectionMethod[];
  vlans: number[];
  tags: string[];
  notes: string;
  custom: Record<string, CustomValue>;
  interfaceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceSaveResult {
  device: Device;
  warnings: string[];
}

export type InterfaceKind =
  "copper" | "sfp" | "sfp-plus" | "qsfp" | "fiber" | "wireless" | "virtual" | "lag";
export type InterfaceMode = "access" | "trunk" | "routed";

export interface Interface {
  id: number;
  deviceId: number;
  name: string;
  kind: InterfaceKind;
  speed: string;
  mode: InterfaceMode;
  accessVlan: number | null;
  nativeVlan: number | null;
  allowedVlans: string;
  lag: string;
  description: string;
  enabled: boolean;
  position: number;
}

export interface BulkResult {
  created: Interface[];
  skipped: string[];
}

export interface Vlan {
  id: number;
  vid: number;
  name: string;
  subnet: string;
  gateway: string;
  description: string;
  color: string;
}

export type FieldKind =
  "text" | "number" | "select" | "multi-select" | "date" | "url" | "ip" | "boolean";

export interface CustomField {
  id: number;
  key: string;
  label: string;
  kind: FieldKind;
  options: string[];
  position: number;
}

/** Profile metadata; secret values never reach the frontend unless revealed. */
export interface CredentialProfile {
  id: number;
  name: string;
  username: string;
  keyPath: string | null;
  autoEnable: boolean;
  notes: string;
  hasPassword: boolean;
  hasKeyData: boolean;
  hasKeyPassphrase: boolean;
  hasEnableSecret: boolean;
}

export type SecretField = "password" | "keyData" | "keyPassphrase" | "enableSecret";

export type SecretUpdate =
  { action: "keep" } | { action: "clear" } | { action: "set"; value: string };

export interface CredentialInput {
  id: number;
  name: string;
  username: string;
  keyPath: string | null;
  autoEnable: boolean;
  notes: string;
  password: SecretUpdate;
  keyData: SecretUpdate;
  keyPassphrase: SecretUpdate;
  enableSecret: SecretUpdate;
}

export interface SavedView {
  id: number;
  name: string;
  state: Record<string, unknown>;
}

export interface InventorySnapshot {
  sites: Site[];
  buildings: Building[];
  floors: Floor[];
  rooms: Room[];
  racks: Rack[];
  vendors: string[];
  credentials: CredentialProfile[];
  vlans: Vlan[];
  fields: CustomField[];
  devices: Device[];
  views: SavedView[];
}

export const inventorySnapshot = () => call<InventorySnapshot>("inventory_snapshot");
export const locationSave = (location: LocationInput) =>
  call<LocationInput>("location_save", { location });
export const locationDelete = (kind: LocationKind, id: number) =>
  call<null>("location_delete", { kind, id });
export const vendorAdd = (name: string) => call<string>("vendor_add", { name });
export const deviceSave = (device: Device) => call<DeviceSaveResult>("device_save", { device });
export const deviceDelete = (id: number) => call<null>("device_delete", { id });
export const deviceDuplicate = (id: number) => call<DeviceSaveResult>("device_duplicate", { id });
export const interfacesList = (deviceId: number) =>
  call<Interface[]>("interfaces_list", { deviceId });
export const interfaceSave = (iface: Interface) =>
  call<Interface>("interface_save", { interface: iface });
export const interfacesBulkCreate = (deviceId: number, pattern: string, template: Interface) =>
  call<BulkResult>("interfaces_bulk_create", { deviceId, pattern, template });
export const interfacesDelete = (deviceId: number, ids: number[]) =>
  call<number>("interfaces_delete", { deviceId, ids });
export const interfacesExpand = (pattern: string) =>
  call<string[]>("interfaces_expand", { pattern });
export const vlanSave = (vlan: Vlan) => call<Vlan>("vlan_save", { vlan });
export const vlanDelete = (id: number) => call<null>("vlan_delete", { id });
export const fieldSave = (field: CustomField) => call<CustomField>("field_save", { field });
export const fieldDelete = (id: number) => call<null>("field_delete", { id });
export const viewSave = (view: SavedView) => call<SavedView>("view_save", { view });
export const viewDelete = (id: number) => call<null>("view_delete", { id });
export const credentialSave = (credential: CredentialInput) =>
  call<CredentialProfile>("credential_save", { credential });
export const credentialDelete = (id: number) => call<null>("credential_delete", { id });
/** Audited. Returns the secret for display only; do not store it. */
export const credentialReveal = (id: number, field: SecretField) =>
  call<string>("credential_reveal", { id, field });
/** Audited. Rust writes the clipboard and clears it after 30 s. */
export const credentialCopy = (id: number, field: SecretField) =>
  call<null>("credential_copy", { id, field });

export interface DeviceOpened {
  sessionId: string;
  connectionId: string | null;
  protocol: "ssh" | "telnet" | "serial";
  title: string;
  vendor: string;
}

export const deviceConnect = (
  deviceId: number,
  method: number,
  cols: number,
  rows: number,
  cb: SessionCallbacks,
) => call<DeviceOpened>("device_connect", { deviceId, method, cols, rows, ...channels(cb) });

// ── Map ────────────────────────────────────────────────────────────────────────────

export type LinkMedia = "copper" | "sm-fiber" | "mm-fiber" | "dac" | "wireless";

export interface LabelOverrides {
  ports: boolean | null;
  speed: boolean | null;
  vlans: boolean | null;
}

/** Mirrors `cairn_core::map::Link`; device ids and interface names are filled when read. */
export interface Link {
  id: number;
  aInterfaceId: number;
  bInterfaceId: number;
  aDeviceId: number;
  bDeviceId: number;
  aName: string;
  bName: string;
  media: LinkMedia;
  speed: string;
  vlans: string;
  lag: string;
  description: string;
  labels: LabelOverrides;
}

export interface MapPosition {
  view: string;
  node: string;
  x: number;
  y: number;
  locked: boolean;
}

export interface Zone {
  id: number;
  view: string;
  name: string;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
  locked: boolean;
}

export interface FloorPlanInfo {
  floorId: number;
  name: string;
  mime: string;
  width: number;
  height: number;
  scale: number;
  opacity: number;
  x: number;
  y: number;
  bytes: number;
}

export type ColorBy = "media" | "speed" | "vlan";

export interface MapPrefs {
  labels: { ports: boolean; speed: boolean; vlans: boolean };
  colorBy: ColorBy;
  snapToGrid: boolean;
  gridSize: number;
  showMinimap: boolean;
}

export interface MapSnapshot {
  links: Link[];
  positions: MapPosition[];
  zones: Zone[];
  floorPlans: FloorPlanInfo[];
  prefs: MapPrefs;
}

export type DiagramFormat = "png" | "svg" | "pdf";

export const mapSnapshot = () => call<MapSnapshot>("map_snapshot");
export const linkSave = (link: Link) => call<Link>("link_save", { link });
export const linkDelete = (id: number) => call<null>("link_delete", { id });
export const mapPositionsSave = (positions: MapPosition[]) =>
  call<null>("map_positions_save", { positions });
export const zoneSave = (zone: Zone) => call<Zone>("zone_save", { zone });
export const zoneDelete = (id: number) => call<null>("zone_delete", { id });
export const mapPrefsUpdate = (prefs: MapPrefs) => call<MapPrefs>("map_prefs_update", { prefs });
export const floorPlanPlace = (
  floorId: number,
  placement: { scale: number; opacity: number; x: number; y: number },
) => call<FloorPlanInfo>("floor_plan_place", { floorId, placement });
export const floorPlanDelete = (floorId: number) => call<null>("floor_plan_delete", { floorId });

/** The floor plan image bytes (raw binary response). */
export async function floorPlanImage(floorId: number): Promise<Uint8Array> {
  try {
    const raw = await invoke<ArrayBuffer | number[]>("floor_plan_image", { floorId });
    return raw instanceof ArrayBuffer ? new Uint8Array(raw) : Uint8Array.from(raw);
  } catch (e) {
    throw CommandError.from(e);
  }
}

/** Upload a floor plan image as a raw body (no JSON byte arrays). */
export async function floorPlanUpload(
  floorId: number,
  name: string,
  data: Uint8Array,
  width: number,
  height: number,
): Promise<FloorPlanInfo> {
  try {
    return await invoke<FloorPlanInfo>("floor_plan_upload", data, {
      headers: {
        "x-cairn-floor": String(floorId),
        "x-cairn-name": encodeURIComponent(name),
        "x-cairn-size": `${width}x${height}`,
      },
    });
  } catch (e) {
    throw CommandError.from(e);
  }
}

/** Render and write a map export; resolves with the written path. Audited. */
export const mapExport = (svg: string, format: DiagramFormat, scale: number, path: string) =>
  call<string>("map_export", { svg, format, scale, path });
