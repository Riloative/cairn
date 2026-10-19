import { save } from "@tauri-apps/plugin-dialog";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import * as ipc from "@/lib/ipc";
import { useNotifications } from "@/stores/notifications";
import { useVault } from "@/stores/vault";
import { PasswordStrengthMeter } from "@/screens/PasswordStrength";
import { MIN_SCORE } from "@/screens/SetupScreen";
import { useStrength } from "@/screens/strength";
import { backupFileName, formatBytes } from "./format";

/** Create an encrypted `.cairn-backup` with its own password. */
export function BackupDialog({
  onClose,
  intro,
}: {
  onClose: () => void;
  /** Shown above the form (the post-setup offer explains why). */
  intro?: ReactNode;
}) {
  const minLength = useVault((s) => s.info?.minPasswordLength ?? 10);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [recordings, setRecordings] = useState(true);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const strength = useStrength(password);
  const notify = useNotifications((s) => s.notify);

  const tooShort = password.length < minLength;
  const tooWeak = !strength || strength.score < MIN_SCORE;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ok = !tooShort && !tooWeak && confirm === password;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!ok || busy) return;
    const path = await save({
      title: "Save backup",
      defaultPath: backupFileName(),
      filters: [{ name: "Cairn backup", extensions: ["cairn-backup"] }],
    });
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      const s = await ipc.backupCreate(path, password, recordings);
      notify({
        variant: "success",
        title: "Backup saved",
        description: `${formatBytes(s.bytes)} · ${path}`,
      });
      onClose();
    } catch (err) {
      setError(ipc.CommandError.from(err).message);
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        title="Create a backup"
        description="Everything Cairn stores, encrypted with a password you choose now. Keep the password apart from the file: without it the backup cannot be restored."
        className="w-[min(520px,calc(100vw-32px))]"
      >
        {intro}
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <Field
            label="Backup password"
            error={
              touched && tooShort
                ? `Use at least ${minLength} characters.`
                : touched && tooWeak
                  ? "Choose a stronger password — a few random words work well."
                  : undefined
            }
          >
            <Input
              type="password"
              autoFocus
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
          </Field>
          <PasswordStrengthMeter result={strength} />
          <Field label="Confirm password" error={mismatch ? "Passwords do not match." : undefined}>
            <Input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={busy}
            />
          </Field>
          <label className="flex items-center gap-2 text-[13px]">
            <Switch
              checked={recordings}
              onCheckedChange={setRecordings}
              aria-label="Include session recordings"
              disabled={busy}
            />
            Include session recordings
          </label>
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || (touched && !ok)}>
              {busy ? "Encrypting…" : "Choose location and save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
