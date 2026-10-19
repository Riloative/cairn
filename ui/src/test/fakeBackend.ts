import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { Channel } from "@tauri-apps/api/core";
import type {
  RdpInput,
  RdpMessage,
  AuditEntry,
  AuditFilter,
  RecordingInfo,
  ErrorPayload,
  PortInfo,
  PortsChanged,
  RemoteEntry,
  Settings,
  TerminalPrefs,
  ConfigSnapshot,
  FileOp,
  ForwardInfo,
  ForwardPreset,
  ForwardSpec,
  SavedConnection,
  Snippet,
  SnapshotInfo,
  TftpPrefs,
  TftpStatus,
  TransferRequest,
  TransferStatus,
  VaultStatus,
} from "@/lib/ipc";
import { DEFAULT_TERMINAL_PREFS } from "@/stores/terminalPrefs";
import { FakeInventory } from "./fakeInventory";
import { FakeMap } from "./fakeMap";

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
  auditRetentionDays: 0,
  recordSessions: false,
  onboardingDone: false,
};

/**
 * In-memory stand-in for the Rust backend, wired through Tauri's official IPC mock. It
 * mirrors the command contract in src-tauri/src/commands so UI flows can be tested.
 */
function withoutContent(s: ConfigSnapshot): SnapshotInfo {
  return {
    id: s.id,
    deviceId: s.deviceId,
    takenAt: s.takenAt,
    command: s.command,
    sha256: s.sha256,
    lines: s.lines,
    bytes: s.bytes,
    note: s.note,
  };
}

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
  inventory = new FakeInventory(
    (kind, payload) => this.log(kind, payload),
    (payload) => this.fail(payload),
  );
  map = new FakeMap(
    this.inventory,
    (kind, payload) => this.log(kind, payload),
    (payload) => this.fail(payload),
  );
  snippets: Snippet[] = [];
  saved: SavedConnection[] = [];
  /** Opened RDP sessions with their channels, for tests to drive. */
  rdpSessions: {
    sessionId: string;
    args: Record<string, unknown>;
    onFrame: Channel<ArrayBuffer>;
    onEvent: Channel<RdpMessage>;
  }[] = [];
  rdpInputs: { sessionId: string; events: RdpInput[] }[] = [];
  rdpClipboard: string[] = [];
  rdpClosed: string[] = [];
  rdpExternal: { deviceId: number; method: number }[] = [];
  promptReplies: { promptId: number; answer: unknown }[] = [];
  recordings: { info: RecordingInfo; cast: string }[] = [];
  /** Sessions the fake reports as recorded. */
  recordingSessions = new Set<string>();
  /** The password the fake's backups are encrypted with. */
  backupPassword = "backup password 42";
  restoredFrom: string | null = null;
  /** Files written by export commands. */
  exports: { what: string; format: string; path: string }[] = [];
  forwards: ForwardInfo[] = [];
  /** Remote folders for the SFTP panel, by path. Null = SFTP not available. */
  remoteFs: Record<string, RemoteEntry[]> | null = {
    "/home/admin": [
      {
        name: "configs",
        path: "/home/admin/configs",
        kind: "dir",
        size: 0,
        modified: 0,
        mode: 0o755,
        owner: "admin",
      },
      {
        name: "notes.txt",
        path: "/home/admin/notes.txt",
        kind: "file",
        size: 2048,
        modified: 0,
        mode: 0o644,
        owner: "admin",
      },
    ],
    "/home/admin/configs": [],
  };
  transfers: TransferRequest[] = [];
  snapshots: ConfigSnapshot[] = [];
  /** What the next config grab returns. */
  nextConfig = "hostname sw1\n!\nend\n";
  forwardPresets: ForwardPreset[] = [];
  tftp: TftpStatus = {
    running: false,
    address: null,
    prefs: {
      root: "",
      bindHost: "0.0.0.0",
      port: 6969,
      allowRead: true,
      allowWrite: false,
      overwrite: false,
    },
    log: [],
  };
  /** Session ids written to, with the text, in order (broadcast assertions). */
  writes: { sessionId: string; text: string }[] = [];
  /** What the native open/save dialog returns. */
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

  /** Same rules as `cairn_core::audit::query`, newest first. */
  private auditMatching(f: AuditFilter): AuditEntry[] {
    const eq = (a: unknown, b: string) =>
      typeof a === "string" && a.toLowerCase() === b.toLowerCase();
    const sessionsWith = (field: string, value: string) =>
      new Set(
        this.audit
          .filter((e) => e.kind === "session_started" && eq(e.payload[field], value))
          .map((e) => e.payload.sessionId),
      );
    const device = f.device?.trim();
    const protocol = f.protocol?.trim();
    const text = f.text?.trim().toLowerCase();
    const deviceSessions = device ? sessionsWith("device", device) : null;
    const protocolSessions = protocol ? sessionsWith("protocol", protocol) : null;
    return this.audit.filter((e) => {
      if (f.from && e.ts < new Date(f.from).toISOString()) return false;
      if (f.to && e.ts >= new Date(f.to).toISOString()) return false;
      if (f.kinds?.length && !f.kinds.includes(e.kind)) return false;
      if (
        device &&
        !eq(e.payload.device, device) &&
        !(
          e.kind === "inventory_changed" &&
          e.payload.entity === "device" &&
          eq(e.payload.name, device)
        ) &&
        !deviceSessions?.has(e.payload.sessionId)
      )
        return false;
      if (
        protocol &&
        !eq(e.payload.protocol, protocol) &&
        !protocolSessions?.has(e.payload.sessionId)
      )
        return false;
      if (text && !JSON.stringify(e.payload).toLowerCase().includes(text) && !e.kind.includes(text))
        return false;
      return true;
    });
  }

  private backupSummary(recordings: boolean) {
    return {
      createdAt: "2026-01-01T00:00:00.000Z",
      appVersion: "0.1.0",
      schemaVersion: 7,
      recordings,
      bytes: 123_456,
    };
  }

  private requireUnlocked() {
    if (this.status !== "unlocked")
      this.fail({ code: "vault.locked", message: "Cairn is locked.", hint: null });
  }

  handle(cmd: string, args: Record<string, unknown>): unknown {
    this.calls.push({ cmd, args });
    if (
      cmd.startsWith("inventory_") ||
      /^(location|vendor|device|interfaces?|vlan|field|view|credential)_/.test(cmd)
    ) {
      this.requireUnlocked();
      const r = this.inventory.handle(cmd, args);
      if (r.handled) return r.result;
    }
    if (/^(map|link|zone|floor_plan)_/.test(cmd)) {
      this.requireUnlocked();
      const r = this.map.handle(cmd, args);
      if (r.handled) return r.result;
    }
    switch (cmd) {
      case "rdp_open":
      case "device_rdp_open": {
        this.requireUnlocked();
        const sessionId = `r${this.rdpSessions.length + 1}`;
        this.rdpSessions.push({
          sessionId,
          args,
          onFrame: args.onFrame as Channel<ArrayBuffer>,
          onEvent: args.onEvent as Channel<RdpMessage>,
        });
        const view = args.view as { width: number; height: number };
        const options = args.options as { host?: string } | undefined;
        return {
          sessionId,
          title: options?.host ?? "device",
          width: view.width,
          height: view.height,
        };
      }
      case "session_prompt_reply":
        this.promptReplies.push({ promptId: args.promptId as number, answer: args.answer });
        return null;
      case "rdp_input":
        this.rdpInputs.push({
          sessionId: args.sessionId as string,
          events: args.events as RdpInput[],
        });
        return null;
      case "rdp_clipboard":
        this.rdpClipboard.push(args.text as string);
        return null;
      case "rdp_close":
        this.rdpClosed.push(args.sessionId as string);
        return null;
      case "rdp_resize":
      case "rdp_ctrl_alt_del":
        return null;
      case "rdp_external":
        this.requireUnlocked();
        this.rdpExternal.push({ deviceId: args.deviceId as number, method: args.method as number });
        return "Opened in xfreerdp3";
      case "saved_connections_list":
        this.requireUnlocked();
        return structuredClone(this.saved);
      case "saved_connection_save": {
        this.requireUnlocked();
        const input = args.connection as SavedConnection;
        if (JSON.stringify(input.settings).includes('"password":"'))
          this.fail({
            code: "validation",
            message: "Passwords are not stored with a saved connection.",
            hint: null,
          });
        const saved = { ...input, id: input.id || 7000 + this.saved.length };
        this.saved = [...this.saved.filter((x) => x.id !== saved.id), saved];
        return structuredClone(saved);
      }
      case "saved_connection_delete":
        this.saved = this.saved.filter((x) => x.id !== args.id);
        return null;
      case "saved_connection_used":
        this.saved = this.saved.map((x) =>
          x.id === args.id ? { ...x, lastUsedAt: new Date().toISOString() } : x,
        );
        return null;
      case "snippets_list":
        this.requireUnlocked();
        return structuredClone(this.snippets);
      case "snippet_save": {
        this.requireUnlocked();
        const input = args.snippet as Snippet;
        const variables = [...input.body.matchAll(/\{\{\s*([A-Za-z_][\w-]*)\s*(?::([^}]*))?\}\}/g)]
          .map((m) => ({ name: m[1] ?? "", default: m[2] ?? "" }))
          .filter((v, i, all) => all.findIndex((x) => x.name === v.name) === i);
        const saved = { ...input, id: input.id || 9000 + this.snippets.length, variables };
        this.snippets = [...this.snippets.filter((x) => x.id !== saved.id), saved];
        return saved;
      }
      case "snippet_delete":
        this.snippets = this.snippets.filter((x) => x.id !== args.id);
        return null;
      case "sftp_home":
        if (!this.remoteFs)
          this.fail({
            code: "ssh.sftp_unavailable",
            message: "SFTP is not available on this device: subsystem request failed",
            hint: "Use SCP instead.",
          });
        return "/home/admin";
      case "sftp_list": {
        const list = this.remoteFs?.[args.path as string];
        if (!list) this.fail({ code: "ssh.sftp", message: "No such file", hint: null });
        return structuredClone(list);
      }
      case "sftp_op": {
        const op = args.op as FileOp;
        const fs = this.remoteFs ?? {};
        const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
        const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
        if (op.op === "mkdir") {
          fs[dirOf(op.path)]?.push({
            name: nameOf(op.path),
            path: op.path,
            kind: "dir",
            size: 0,
            modified: 0,
            mode: 0o755,
            owner: "admin",
          });
          fs[op.path] = [];
        } else if (op.op === "remove") {
          const dir = fs[dirOf(op.path)];
          if (dir) fs[dirOf(op.path)] = dir.filter((e) => e.path !== op.path);
        } else if (op.op === "rename") {
          const dir = fs[dirOf(op.from)];
          const e = dir?.find((x) => x.path === op.from);
          if (e) Object.assign(e, { path: op.to, name: nameOf(op.to) });
        } else {
          const dir = fs[dirOf(op.path)];
          const e = dir?.find((x) => x.path === op.path);
          if (e) e.mode = op.mode;
        }
        return null;
      }
      case "file_transfer": {
        const req = args.request as TransferRequest;
        this.transfers.push(req);
        this.log("file_transferred", {
          protocol: req.protocol,
          direction: req.direction,
          file: req.remotePath,
          ok: true,
        });
        if (req.direction === "upload" && req.protocol === "sftp") {
          const dir = req.remotePath.slice(0, req.remotePath.lastIndexOf("/"));
          const name = req.remotePath.slice(req.remotePath.lastIndexOf("/") + 1);
          this.remoteFs?.[dir]?.push({
            name,
            path: req.remotePath,
            kind: "file",
            size: 10,
            modified: 0,
            mode: 0o644,
            owner: "admin",
          });
        }
        return 10;
      }
      case "file_transfer_cancel":
        return null;
      case "plugin:dialog|save":
        return this.dialogResult;
      case "config_grab": {
        this.requireUnlocked();
        const deviceId = args.deviceId as number;
        const prev = this.snapshots.filter((x) => x.deviceId === deviceId).at(-1);
        const sha = `sha-${this.nextConfig.length}-${this.nextConfig.charCodeAt(9)}`;
        const snap: ConfigSnapshot = {
          id: this.snapshots.length + 1,
          deviceId,
          takenAt: new Date(Date.UTC(2026, 9, 1 + this.snapshots.length, 12)).toISOString(),
          command: "show running-config",
          sha256: sha,
          lines: this.nextConfig.split("\n").length - 1,
          bytes: this.nextConfig.length,
          note: "",
          content: this.nextConfig,
        };
        this.snapshots.push(snap);
        const info = withoutContent(snap);
        this.log("config_grabbed", { deviceId, ok: true, sessionId: args.sessionId });
        return { snapshot: info, changed: prev?.sha256 !== sha };
      }
      case "config_snapshots":
        return this.snapshots
          .filter((x) => x.deviceId === args.deviceId)
          .map(withoutContent)
          .reverse();
      case "config_snapshot":
        return structuredClone(this.snapshots.find((x) => x.id === args.id));
      case "config_snapshot_delete":
        this.snapshots = this.snapshots.filter((x) => x.id !== args.id);
        return null;
      case "config_snapshot_note":
        return null;
      case "config_diff": {
        const lines = (id: unknown) =>
          (this.snapshots.find((x) => x.id === id)?.content ?? "").replace(/\n$/, "").split("\n");
        const a = lines(args.oldId);
        const b = lines(args.newId);
        const rows = Array.from({ length: Math.max(a.length, b.length) }, (_, i) => {
          const l = a[i];
          const r = b[i];
          const kind =
            l === r ? "same" : l === undefined ? "added" : r === undefined ? "removed" : "changed";
          return {
            kind,
            left: l === undefined ? null : { n: i + 1, text: l },
            right: r === undefined ? null : { n: i + 1, text: r },
          };
        });
        return {
          rows,
          added: rows.filter((r) => r.kind !== "same" && r.right).length,
          removed: rows.filter((r) => r.kind !== "same" && r.left).length,
        };
      }
      case "config_export":
        this.log("data_exported", {
          what: "configuration",
          path: args.path,
          against: args.against,
        });
        return args.path;
      case "forward_start": {
        this.requireUnlocked();
        const spec = args.spec as ForwardSpec;
        if (spec.bindPort === 22)
          this.fail({
            code: "ssh.forward_bind",
            message: "Could not listen on 127.0.0.1:22: address in use",
            hint: null,
          });
        const bound = spec.bindPort || 40000 + this.forwards.length;
        const summary =
          spec.kind === "dynamic"
            ? `D ${spec.bindHost}:${bound} (SOCKS5)`
            : `${spec.kind === "local" ? "L" : "R"} ${spec.bindHost}:${bound} → ${spec.destHost}:${spec.destPort}`;
        const info: ForwardInfo = {
          id: this.forwards.length + 1,
          sessionId: args.sessionId as string,
          target: "10.0.0.2:22",
          presetId: null,
          spec: { ...spec, bindPort: bound },
          summary,
          boundPort: bound,
          counters: { active: 0, total: 0, bytesOut: 0, bytesIn: 0, lastError: null },
        };
        this.forwards.push(info);
        this.log("port_forward", { action: "started", forward: summary });
        return info;
      }
      case "forward_stop":
        this.forwards = this.forwards.filter((f) => f.id !== args.id);
        this.log("port_forward", { action: "stopped" });
        return null;
      case "forwards_list":
        return structuredClone(this.forwards);
      case "forwards_autostart":
        return [];
      case "forward_presets_list":
        return structuredClone(this.forwardPresets);
      case "forward_preset_save": {
        const p = args.preset as ForwardPreset;
        const saved = { ...p, id: p.id || 700 + this.forwardPresets.length };
        this.forwardPresets = [...this.forwardPresets.filter((x) => x.id !== saved.id), saved];
        return saved;
      }
      case "forward_preset_delete":
        this.forwardPresets = this.forwardPresets.filter((x) => x.id !== args.id);
        return null;
      case "tftp_status":
        return structuredClone(this.tftp);
      case "tftp_prefs_update":
        this.tftp.prefs = args.prefs as TftpPrefs;
        return this.tftp.prefs;
      case "tftp_start": {
        this.requireUnlocked();
        const prefs = args.prefs as TftpPrefs;
        if (prefs.port < 1024)
          this.fail({
            code: "tftp.permission",
            message: `Cairn may not listen on ${prefs.bindHost}:${prefs.port}: permission denied`,
            hint: "Port is privileged.",
          });
        this.tftp = {
          ...this.tftp,
          running: true,
          prefs,
          address: `${prefs.bindHost}:${prefs.port}`,
        };
        this.log("tftp_server", { action: "started" });
        return structuredClone(this.tftp);
      }
      case "tftp_stop":
        if (this.tftp.running) this.log("tftp_server", { action: "stopped" });
        this.tftp = { ...this.tftp, running: false, address: null };
        return structuredClone(this.tftp);
      case "tftp_clear_log":
        this.tftp.log = [];
        return null;
      case "local_addresses":
        return [{ interface: "eth0", address: "192.168.1.10" }];
      case "broadcast_started":
        this.log("broadcast_started", { targets: args.targets });
        return null;
      case "broadcast_ended":
        this.log("broadcast_ended", { targets: args.targets, durationSecs: args.durationSecs });
        return null;
      case "app_info":
        return { name: "Cairn", version: "0.1.0", os: "linux", arch: "x86_64" };
      case "vault_status":
        return this.info();
      case "backup_create": {
        this.requireUnlocked();
        if (String(args.password).length < 10)
          this.fail({
            code: "validation",
            message: "The backup password must be at least 10 characters.",
            hint: null,
          });
        this.exports.push({ what: "backup", format: "cairn-backup", path: args.path as string });
        this.log("data_exported", { what: "full backup", format: "cairn-backup", path: args.path });
        return this.backupSummary(Boolean(args.recordings));
      }
      case "data_export": {
        this.requireUnlocked();
        const creds = Boolean(args.includeCredentials);
        this.exports.push({
          what: creds ? "inventory+credentials" : "inventory",
          format: args.format as string,
          path: args.path as string,
        });
        this.log("data_exported", {
          what: creds ? "inventory with credentials and their secrets" : "inventory",
          format: args.format,
          path: args.path,
        });
        const path = args.path as string;
        return args.format === "json"
          ? [path]
          : [
              "locations",
              "devices",
              "interfaces",
              "links",
              "vlans",
              ...(creds ? ["credentials"] : []),
            ].map((n) => `${path}/${n}.csv`);
      }
      case "backup_inspect":
        if (!String(args.path).endsWith(".cairn-backup"))
          this.fail({
            code: "validation",
            message: "This file is not a Cairn backup.",
            hint: null,
          });
        return this.backupSummary(true);
      case "backup_restore": {
        if (this.status === "locked")
          this.fail({ code: "vault.locked", message: "Cairn is locked.", hint: null });
        if (args.backupPassword !== this.backupPassword)
          this.fail({
            code: "vault.wrong_password",
            message: "The master password is incorrect.",
            hint: null,
          });
        if (this.status === "unlocked" && args.masterPassword !== this.password)
          this.fail({
            code: "vault.wrong_password",
            message: "The master password is incorrect.",
            hint: null,
          });
        this.password = String(args.masterPassword);
        this.status = "unlocked";
        this.restoredFrom = args.path as string;
        this.log("backup_restored", { backupCreatedAt: "2026-01-01T00:00:00.000Z" });
        return this.info();
      }
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
      case "audit_verify":
        this.requireUnlocked();
        return { ok: true, entries: this.audit.length, firstBadSeq: null, prunedBefore: null };
      case "audit_query": {
        this.requireUnlocked();
        const matching = this.auditMatching(args.filter as AuditFilter);
        const before = (args.beforeSeq as number | null) ?? Infinity;
        return {
          entries: matching.filter((e) => e.seq < before).slice(0, Number(args.limit)),
          total: matching.length,
        };
      }
      case "audit_facets": {
        this.requireUnlocked();
        const str = (v: unknown) => (typeof v === "string" && v ? [v] : []);
        const uniq = (xs: string[]) => [...new Set(xs)].sort();
        return {
          kinds: uniq(this.audit.map((e) => e.kind)),
          devices: uniq(this.audit.flatMap((e) => str(e.payload.device))),
          protocols: uniq(
            this.audit
              .filter((e) => e.kind === "session_started")
              .flatMap((e) => str(e.payload.protocol)),
          ),
        };
      }
      case "recordings_list":
        this.requireUnlocked();
        return this.recordings.map((r) => r.info);
      case "recording_cast": {
        this.requireUnlocked();
        const r = this.recordings.find((x) => x.info.id === args.id);
        if (!r)
          this.fail({
            code: "validation",
            message: "That recording no longer exists.",
            hint: null,
          });
        return r.cast;
      }
      case "recording_export":
        this.requireUnlocked();
        this.exports.push({
          what: `recording ${String(args.id)}`,
          format: args.format as string,
          path: args.path as string,
        });
        return null;
      case "recording_delete":
        this.requireUnlocked();
        this.recordings = this.recordings.filter((r) => r.info.id !== args.id);
        this.log("recording_deleted", { recordingId: args.id });
        return null;
      case "session_recording":
        return this.recordingSessions.has(args.sessionId as string);
      case "audit_export": {
        this.requireUnlocked();
        const count = this.auditMatching(args.filter as AuditFilter).length;
        this.exports.push({
          what: "audit",
          format: args.format as string,
          path: args.path as string,
        });
        return count;
      }
      default:
        throw new Error(`FakeBackend: unhandled command ${cmd}`);
    }
  }
}
