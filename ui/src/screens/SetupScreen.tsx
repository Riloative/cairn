import { AlertTriangle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { CommandError } from "@/lib/ipc";
import { RestoreDialog } from "@/backup/RestoreDialog";
import { useVault } from "@/stores/vault";
import { AuthLayout, WorkingBar } from "./AuthLayout";
import { PasswordStrengthMeter } from "./PasswordStrength";
import { useStrength } from "./strength";

/** Minimum zxcvbn score accepted for a master password ("Fair"). */
export const MIN_SCORE = 2;

export function SetupScreen() {
  const setup = useVault((s) => s.setup);
  const minLength = useVault((s) => s.info?.minPasswordLength ?? 10);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const strength = useStrength(password);

  const tooShort = password.length < minLength;
  const tooWeak = !strength || strength.score < MIN_SCORE;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = !tooShort && !tooWeak && confirm === password && acknowledged && !busy;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await setup(password);
    } catch (err) {
      setError(CommandError.from(err).message);
      setBusy(false);
    }
  }

  const passwordError = touched
    ? tooShort
      ? `Use at least ${minLength} characters.`
      : tooWeak
        ? "Choose a stronger password — a few random words work well."
        : undefined
    : undefined;

  return (
    <AuthLayout>
      <h1 className="text-xl font-semibold tracking-tight">Create a master password</h1>
      <p className="mt-1 text-fg-muted">
        It encrypts everything Cairn stores on this machine: inventory, credentials, keys and the
        audit log.
      </p>
      <form className="mt-6 flex flex-col gap-4" onSubmit={submit} noValidate>
        <Field label="Master password" error={passwordError}>
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
        <label className="flex gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-[13px]">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
          <span className="flex-1">
            <span className="font-medium">There is no recovery.</span>{" "}
            <span className="text-fg-muted">
              If you forget this password, your Cairn data cannot be decrypted. Keep it in a
              password manager and make encrypted backups.
            </span>
            <span className="mt-2 flex items-center gap-2">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="size-4 accent-[var(--accent)]"
              />
              I understand
            </span>
          </span>
        </label>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        {busy && <WorkingBar />}
        <Button type="submit" variant="primary" size="lg" disabled={!canSubmit}>
          {busy ? "Securing your vault…" : "Create vault"}
        </Button>
      </form>
      <p className="mt-4 text-center text-xs text-fg-muted">
        Moving from another computer?{" "}
        <button
          type="button"
          className="text-accent hover:underline"
          onClick={() => setRestoring(true)}
          disabled={busy}
        >
          Restore from a backup
        </button>
      </p>
      {restoring && <RestoreDialog mode="setup" onClose={() => setRestoring(false)} />}
    </AuthLayout>
  );
}
