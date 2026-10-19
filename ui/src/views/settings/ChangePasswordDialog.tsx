import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { CommandError, vaultChangePassword } from "@/lib/ipc";
import { MIN_SCORE } from "@/screens/SetupScreen";
import { PasswordStrengthMeter } from "@/screens/PasswordStrength";
import { useStrength } from "@/screens/strength";
import { WorkingBar } from "@/screens/AuthLayout";
import { useNotifications } from "@/stores/notifications";
import { useVault } from "@/stores/vault";

export function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const minLength = useVault((s) => s.info?.minPasswordLength ?? 10);
  const notify = useNotifications((s) => s.notify);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const strength = useStrength(next);

  const valid =
    current.length > 0 &&
    next.length >= minLength &&
    (strength?.score ?? 0) >= MIN_SCORE &&
    next === confirm &&
    next !== current;

  function reset() {
    setCurrent("");
    setNext("");
    setConfirm("");
    setError(null);
    setBusy(false);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await vaultChangePassword(current, next);
      notify({ title: "Master password changed", variant: "success" });
      reset();
      onOpenChange(false);
    } catch (err) {
      setError(CommandError.from(err).message);
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent
        title="Change master password"
        description="Your database is re-encrypted with the new password."
      >
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <Field label="Current password">
            <Input
              type="password"
              autoFocus
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field
            label="New password"
            description={`At least ${minLength} characters.`}
            error={next && next === current ? "Choose a different password." : undefined}
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <PasswordStrengthMeter result={strength} />
          <Field
            label="Confirm new password"
            error={confirm && confirm !== next ? "Passwords do not match." : undefined}
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
          {busy && <WorkingBar />}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!valid || busy}>
              {busy ? "Re-encrypting…" : "Change password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
