import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, FileArchive } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import * as ipc from "@/lib/ipc";
import type { BackupSummary } from "@/lib/ipc";
import { useSessions } from "@/stores/sessions";
import { useVault } from "@/stores/vault";
import { PasswordStrengthMeter } from "@/screens/PasswordStrength";
import { MIN_SCORE } from "@/screens/SetupScreen";
import { useStrength } from "@/screens/strength";
import { formatBytes } from "./format";
import { reloadApp } from "./reload";

/**
 * Restore a `.cairn-backup`. `replace` (unlocked) swaps all data and asks for the
 * current master password; `setup` (first launch) sets a new master password.
 */
export function RestoreDialog({
  mode,
  onClose,
}: {
  mode: "replace" | "setup";
  onClose: () => void;
}) {
  const restore = useVault((s) => s.restore);
  const minLength = useVault((s) => s.info?.minPasswordLength ?? 10);
  const openTabs = useSessions((s) => s.tabs.length);
  const [file, setFile] = useState<{ path: string; summary: BackupSummary } | null>(null);
  const [backupPassword, setBackupPassword] = useState("");
  const [master, setMaster] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const strength = useStrength(mode === "setup" ? master : "");

  async function choose() {
    setError(null);
    const picked = await openFileDialog({
      title: "Choose a backup",
      filters: [{ name: "Cairn backup", extensions: ["cairn-backup"] }],
    });
    if (typeof picked !== "string") return;
    try {
      setFile({ path: picked, summary: await ipc.backupInspect(picked) });
    } catch (e) {
      setFile(null);
      setError(ipc.CommandError.from(e).message);
    }
  }

  const newMasterOk =
    mode === "replace" ||
    (master.length >= minLength && !!strength && strength.score >= MIN_SCORE && confirm === master);
  const blockedBySessions = mode === "replace" && openTabs > 0;
  const canSubmit =
    !!file &&
    backupPassword.length > 0 &&
    master.length > 0 &&
    newMasterOk &&
    !busy &&
    !blockedBySessions;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await restore(file.path, backupPassword, master);
      reloadApp();
    } catch (err) {
      const e2 = ipc.CommandError.from(err);
      setError(
        e2.code === "vault.wrong_password"
          ? mode === "replace"
            ? "The backup password or your master password is wrong."
            : "The backup password is wrong."
          : e2.message,
      );
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        title="Restore a backup"
        description={
          mode === "replace"
            ? "Everything in Cairn on this computer is replaced by the backup: inventory, credentials, settings, snapshots, recordings and the audit log."
            : "Start from a backup made on this or another computer, and choose the master password for this computer."
        }
        className="w-[min(520px,calc(100vw-32px))]"
      >
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <div className="flex items-center gap-3 rounded-lg bg-surface-raised p-3">
            <FileArchive size={18} className="shrink-0 text-fg-muted" />
            <div className="min-w-0 flex-1 text-[13px]">
              {file ? (
                <>
                  <p className="truncate font-medium" title={file.path}>
                    {file.path.split(/[\\/]/).pop()}
                  </p>
                  <p className="text-xs text-fg-muted">
                    Made {new Date(file.summary.createdAt).toLocaleString()} with Cairn{" "}
                    {file.summary.appVersion} · {formatBytes(file.summary.bytes)}
                    {file.summary.recordings ? " · with recordings" : ""}
                  </p>
                </>
              ) : (
                <p className="text-fg-muted">No backup chosen</p>
              )}
            </div>
            <Button type="button" size="sm" onClick={() => void choose()} disabled={busy}>
              {file ? "Change…" : "Choose…"}
            </Button>
          </div>
          {file && (
            <>
              <Field label="Backup password">
                <Input
                  type="password"
                  autoFocus
                  autoComplete="off"
                  value={backupPassword}
                  onChange={(e) => setBackupPassword(e.target.value)}
                  disabled={busy}
                />
              </Field>
              {mode === "replace" ? (
                <Field
                  label="Your master password"
                  description="Confirms that you want to replace everything."
                >
                  <Input
                    type="password"
                    autoComplete="current-password"
                    value={master}
                    onChange={(e) => setMaster(e.target.value)}
                    disabled={busy}
                  />
                </Field>
              ) : (
                <>
                  <Field
                    label="New master password"
                    description={`At least ${minLength} characters.`}
                  >
                    <Input
                      type="password"
                      autoComplete="new-password"
                      value={master}
                      onChange={(e) => setMaster(e.target.value)}
                      disabled={busy}
                    />
                  </Field>
                  <PasswordStrengthMeter result={strength} />
                  <Field
                    label="Confirm master password"
                    error={
                      confirm.length > 0 && confirm !== master
                        ? "Passwords do not match."
                        : undefined
                    }
                  >
                    <Input
                      type="password"
                      autoComplete="new-password"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      disabled={busy}
                    />
                  </Field>
                </>
              )}
            </>
          )}
          {blockedBySessions && (
            <p className="flex items-center gap-2 text-xs text-warning">
              <AlertTriangle size={14} /> Close all sessions before restoring.
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={mode === "replace" ? "danger" : "primary"}
              disabled={!canSubmit}
            >
              {busy ? "Restoring…" : mode === "replace" ? "Replace everything" : "Restore"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
