import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { CommandError, type LockReason } from "@/lib/ipc";
import { useVault } from "@/stores/vault";
import { AuthLayout, WorkingBar } from "./AuthLayout";

const REASON: Record<LockReason, string> = {
  manual: "Cairn is locked.",
  idle: "Cairn locked after a period of inactivity.",
  system_sleep: "Cairn locked when your computer went to sleep.",
};

export function LockScreen() {
  const unlock = useVault((s) => s.unlock);
  const failed = useVault((s) => s.info?.failedAttempts ?? 0);
  const reason = useVault((s) => s.lockReason);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CommandError | null>(null);
  const [capsLock, setCapsLock] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Return focus to the field after a failed attempt so the user can retype at once.
  useEffect(() => {
    if (!busy) inputRef.current?.focus();
  }, [busy]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await unlock(password);
    } catch (err) {
      setError(CommandError.from(err));
      setPassword("");
      setBusy(false);
    }
  }

  const onKey = (e: KeyboardEvent) => setCapsLock(e.getModifierState("CapsLock"));

  return (
    <AuthLayout>
      <h1 className="text-xl font-semibold tracking-tight">Welcome back</h1>
      <p className="mt-1 text-fg-muted">{REASON[reason ?? "manual"]}</p>
      <form className="mt-6 flex flex-col gap-4" onSubmit={submit}>
        <Field
          label="Master password"
          error={error ? error.message : undefined}
          description={capsLock ? "Caps Lock is on." : undefined}
        >
          <Input
            ref={inputRef}
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={onKey}
            onKeyUp={onKey}
            disabled={busy}
          />
        </Field>
        {failed > 0 && (
          <p className="text-xs text-warning">
            {failed} failed {failed === 1 ? "attempt" : "attempts"} since the last unlock. These are
            recorded in the audit log.
          </p>
        )}
        {busy && <WorkingBar />}
        <Button type="submit" variant="primary" size="lg" disabled={!password || busy}>
          {busy ? "Unlocking…" : "Unlock"}
        </Button>
      </form>
    </AuthLayout>
  );
}
