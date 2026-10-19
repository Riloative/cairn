import type { AuditEntry } from "@/lib/ipc";

export const LABELS: Record<string, string> = {
  vault_created: "Vault created",
  app_unlocked: "Unlocked",
  app_locked: "Locked",
  unlock_failed: "Failed unlock attempt",
  master_password_changed: "Master password changed",
  settings_changed: "Settings changed",
  integrity_verified: "Integrity verified",
  host_key_trusted: "Host key trusted",
  host_key_rejected: "Host key rejected",
  session_started: "Session started",
  session_ended: "Session ended",
  file_transferred: "File transferred",
  inventory_changed: "Inventory changed",
  credential_revealed: "Secret revealed",
  credential_copied: "Secret copied",
  data_exported: "Data exported",
  broadcast_started: "Broadcast started",
  broadcast_ended: "Broadcast ended",
  config_grabbed: "Config grabbed",
  port_forward: "Port forward",
  tftp_server: "TFTP server",
};

const list = (v: unknown) => ((v as string[] | undefined) ?? []).join(", ");

export const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

/** One-line human summary of an entry's payload. */
export function summarize(entry: AuditEntry): string {
  const p = entry.payload;
  switch (entry.kind) {
    case "app_locked":
      return String(p.reason).replace("_", " ");
    case "unlock_failed":
      return `at ${dateFormat.format(new Date(String(p.at)))}`;
    case "settings_changed":
      return ((p.changes as { field: string }[] | undefined) ?? []).map((c) => c.field).join(", ");
    case "integrity_verified":
      return p.ok ? `${String(p.entries)} entries intact` : "chain broken";
    case "host_key_trusted":
    case "host_key_rejected":
      return `${String(p.host)}:${String(p.port)} ${String(p.fingerprint)}`;
    case "session_started":
    case "session_ended":
      return p.device
        ? `${String(p.protocol)} ${String(p.device)} (${String(p.target)})`
        : `${String(p.protocol)} ${String(p.target)}`;
    case "file_transferred": {
      const arrow = p.direction === "upload" || p.direction === "send" ? "sent" : "received";
      const what = p.file ? String(p.file) : "file";
      // TFTP transfers carry the peer address in place of a session id.
      const peer = String(p.sessionId ?? "").startsWith("tftp ")
        ? ` ${arrow === "sent" ? "to" : "from"} ${String(p.sessionId).slice(5)}`
        : "";
      return p.ok === false
        ? `${what} not ${arrow}${peer}: ${String(p.error)}`
        : `${what} ${arrow}${peer} (${String(p.bytes)} bytes, ${String(p.protocol)})`;
    }
    case "data_exported":
      return `${String(p.what)} as ${String(p.format)} to ${String(p.path)}`;
    case "broadcast_started":
      return `to ${list(p.targets)}`;
    case "broadcast_ended":
      return `to ${list(p.targets)} after ${String(p.durationSecs)} s`;
    case "config_grabbed":
      if (p.ok === false) return `${String(p.device)} failed: ${String(p.error)}`;
      return `${String(p.device)}: ${String(p.bytes)} bytes, ${p.changed ? "changed" : "unchanged"}`;
    case "port_forward":
      return p.error
        ? `${String(p.forward)} on ${String(p.target)} ${String(p.action)}: ${String(p.error)}`
        : `${String(p.forward)} on ${String(p.target)} ${String(p.action)}`;
    case "tftp_server":
      return `${String(p.action)} on ${String(p.bind)} serving ${String(p.root)}${p.allowWrite ? " (uploads allowed)" : ""}`;
    case "inventory_changed": {
      const fields = ((p.changes as { field: string }[] | undefined) ?? [])
        .map((c) => c.field)
        .filter(Boolean);
      const what = `${String(p.entity).replace("_", " ")} ${String(p.name)} ${String(p.action)}`;
      return p.action === "updated" && fields.length ? `${what}: ${fields.join(", ")}` : what;
    }
    case "credential_revealed":
    case "credential_copied":
      return `${String(p.field)} of ${String(p.name)}`;
    default:
      return "";
  }
}
