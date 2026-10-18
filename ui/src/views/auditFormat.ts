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
};

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
      return `${String(p.protocol)} ${String(p.target)}`;
    case "file_transferred": {
      const arrow = p.direction === "upload" ? "sent" : "received";
      const what = p.file ? String(p.file) : "file";
      return p.ok === false
        ? `${what} not ${arrow}: ${String(p.error)}`
        : `${what} ${arrow} (${String(p.bytes)} bytes, ${String(p.protocol)})`;
    }
    default:
      return "";
  }
}
