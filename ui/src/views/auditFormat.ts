import type { AuditEntry } from "@/lib/ipc";

export const LABELS: Record<string, string> = {
  vault_created: "Vault created",
  app_unlocked: "Unlocked",
  app_locked: "Locked",
  unlock_failed: "Failed unlock attempt",
  master_password_changed: "Master password changed",
  settings_changed: "Settings changed",
  integrity_verified: "Integrity verified",
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
    default:
      return "";
  }
}
