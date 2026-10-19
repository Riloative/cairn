import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { Copy, Eye, EyeOff, KeyRound, Plus } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import * as ipc from "@/lib/ipc";
import type {
  CredentialInput,
  CredentialProfile,
  InventorySnapshot,
  SecretField,
  SecretUpdate,
} from "@/lib/ipc";
import { confirmAction } from "@/stores/confirm";
import { useNotifications } from "@/stores/notifications";
import { mutate } from "./mutate";

const KEEP: SecretUpdate = { action: "keep" };

const SECRET_LABEL: Record<SecretField, string> = {
  password: "Password",
  keyData: "Private key",
  keyPassphrase: "Key passphrase",
  enableSecret: "Enable secret",
};

/** Hide a revealed secret again after this long. */
const REVEAL_MS = 30_000;

function stored(p: CredentialProfile | null, f: SecretField): boolean {
  if (!p) return false;
  switch (f) {
    case "password":
      return p.hasPassword;
    case "keyData":
      return p.hasKeyData;
    case "keyPassphrase":
      return p.hasKeyPassphrase;
    case "enableSecret":
      return p.hasEnableSecret;
  }
}

/**
 * One secret: masked when stored (reveal/copy are audited in Rust), typed when set.
 * Typed or revealed values live only in this component's state.
 */
function SecretInput({
  field,
  profile,
  update,
  onChange,
  multiline,
}: {
  field: SecretField;
  profile: CredentialProfile | null;
  update: SecretUpdate;
  onChange: (u: SecretUpdate) => void;
  multiline?: boolean;
}) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const has = stored(profile, field);
  const label = SECRET_LABEL[field];

  useEffect(() => {
    if (revealed === null) return;
    const t = setTimeout(() => setRevealed(null), REVEAL_MS);
    return () => clearTimeout(t);
  }, [revealed]);

  async function reveal() {
    if (!profile) return;
    try {
      setRevealed(await ipc.credentialReveal(profile.id, field));
    } catch (e) {
      useNotifications.getState().notifyError(e, `Could not reveal the ${label.toLowerCase()}`);
    }
  }

  async function copy() {
    if (!profile) return;
    try {
      await ipc.credentialCopy(profile.id, field);
      useNotifications.getState().notify({
        variant: "success",
        title: `${label} copied`,
        description: "The clipboard is cleared in 30 seconds.",
      });
    } catch (e) {
      useNotifications.getState().notifyError(e, `Could not copy the ${label.toLowerCase()}`);
    }
  }

  if (has && update.action === "keep") {
    return (
      <Field label={label}>
        <div className="flex items-center gap-1">
          <Input
            readOnly
            aria-label={`${label} (stored)`}
            className="font-mono"
            value={revealed ?? "••••••••••"}
            type="text"
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
            onClick={() => (revealed ? setRevealed(null) : void reveal())}
          >
            {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Copy ${label}`}
            onClick={() => void copy()}
          >
            <Copy size={14} />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onChange({ action: "set", value: "" })}
          >
            Change
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onChange({ action: "clear" })}
          >
            Remove
          </Button>
        </div>
      </Field>
    );
  }
  if (update.action === "clear") {
    return (
      <Field label={label}>
        <div className="flex h-8 items-center gap-2 text-fg-muted">
          Will be removed on save.
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange(KEEP)}>
            Undo
          </Button>
        </div>
      </Field>
    );
  }
  const value = update.action === "set" ? update.value : "";
  const set = (v: string) =>
    onChange(v ? { action: "set", value: v } : has ? { action: "set", value: "" } : KEEP);
  return (
    <Field
      label={label}
      description={
        has
          ? "Replaces the stored value."
          : multiline
            ? "Paste an OpenSSH or PEM private key."
            : undefined
      }
    >
      {multiline ? (
        <textarea
          rows={4}
          spellCheck={false}
          autoComplete="off"
          aria-label={label}
          className="rounded-md border border-border bg-surface p-2.5 font-mono text-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          value={value}
          onChange={(e) => set(e.target.value)}
        />
      ) : (
        <Input
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => set(e.target.value)}
        />
      )}
    </Field>
  );
}

function blankInput(p: CredentialProfile | null): CredentialInput {
  return {
    id: p?.id ?? 0,
    name: p?.name ?? "",
    username: p?.username ?? "",
    keyPath: p?.keyPath ?? null,
    autoEnable: p?.autoEnable ?? false,
    notes: p?.notes ?? "",
    password: KEEP,
    keyData: KEEP,
    keyPassphrase: KEEP,
    enableSecret: KEEP,
  };
}

function CredentialDialog({
  profile,
  onClose,
}: {
  profile: CredentialProfile | null;
  onClose: () => void;
}) {
  const [input, setInput] = useState<CredentialInput>(() => blankInput(profile));
  const [touched, setTouched] = useState(false);
  const set = <K extends keyof CredentialInput>(k: K, v: CredentialInput[K]) =>
    setInput((x) => ({ ...x, [k]: v }));
  const nameError = touched && !input.name.trim() ? "Enter a name." : undefined;
  const emptySet = (["password", "keyData", "keyPassphrase", "enableSecret"] as const).find((f) => {
    const u = input[f];
    return u.action === "set" && !u.value;
  });

  async function browseKey() {
    try {
      const path = await openFileDialog({
        multiple: false,
        directory: false,
        title: "Private key",
      });
      if (typeof path === "string") set("keyPath", path);
    } catch (e) {
      useNotifications.getState().notifyError(e, "Could not open the file picker");
    }
  }

  function close() {
    // Typed secrets are dropped with the state.
    setInput(blankInput(null));
    onClose();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!input.name.trim() || emptySet) return;
    const saved = await mutate(
      () => ipc.credentialSave({ ...input, keyPath: input.keyPath?.trim() || null }),
      {
        error: "Could not save the credential profile",
      },
    );
    if (saved) close();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent
        title={profile ? `Edit ${profile.name}` : "New credential profile"}
        description="Secrets are stored only in the encrypted vault. Revealing or copying one is recorded in the audit log."
        className="w-[min(560px,calc(100vw-32px))]"
      >
        <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" error={nameError}>
              <Input autoFocus value={input.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
            <Field label="Username">
              <Input
                spellCheck={false}
                autoCapitalize="off"
                value={input.username}
                onChange={(e) => set("username", e.target.value)}
              />
            </Field>
          </div>
          <SecretInput
            field="password"
            profile={profile}
            update={input.password}
            onChange={(u) => set("password", u)}
          />
          <Field label="Private key file" description="Or store the key itself below.">
            <div className="flex gap-2">
              <Input
                spellCheck={false}
                placeholder="~/.ssh/id_ed25519"
                value={input.keyPath ?? ""}
                onChange={(e) => set("keyPath", e.target.value)}
              />
              <Button type="button" onClick={() => void browseKey()}>
                Browse…
              </Button>
            </div>
          </Field>
          <SecretInput
            field="keyData"
            profile={profile}
            update={input.keyData}
            onChange={(u) => set("keyData", u)}
            multiline
          />
          <SecretInput
            field="keyPassphrase"
            profile={profile}
            update={input.keyPassphrase}
            onChange={(u) => set("keyPassphrase", u)}
          />
          <SecretInput
            field="enableSecret"
            profile={profile}
            update={input.enableSecret}
            onChange={(u) => set("enableSecret", u)}
          />
          <label className="flex items-center gap-2 text-[13px]">
            <Switch
              checked={input.autoEnable}
              onCheckedChange={(v) => set("autoEnable", v)}
              aria-label="Enter enable mode on connect"
            />
            Enter enable mode on connect
          </label>
          <Field label="Notes">
            <Input value={input.notes} onChange={(e) => set("notes", e.target.value)} />
          </Field>
          {touched && emptySet && (
            <p role="alert" className="text-xs text-danger">
              Enter the new {SECRET_LABEL[emptySet].toLowerCase()} or keep the stored one.
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              {profile ? "Save" : "Add profile"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CredentialsSection({ snapshot }: { snapshot: InventorySnapshot }) {
  const [editing, setEditing] = useState<{ profile: CredentialProfile | null } | null>(null);
  const usedBy = (id: number) => snapshot.devices.filter((d) => d.credentialId === id).length;

  async function remove(p: CredentialProfile) {
    const n = usedBy(p.id);
    const ok = await confirmAction({
      title: `Delete ${p.name}?`,
      description: `Its secrets are erased from the vault.${n ? ` ${n} devices will have no credentials.` : ""}`,
      confirmLabel: "Delete profile",
      destructive: true,
    });
    if (ok) await mutate(() => ipc.credentialDelete(p.id), { error: `Could not delete ${p.name}` });
  }

  return (
    <div className="flex h-full flex-col">
      {snapshot.credentials.length === 0 ? (
        <EmptyState
          icon={<KeyRound size={20} />}
          title="No credential profiles"
          description="Store a username with a password or key (and an optional enable secret) once, then assign it to devices. Secrets never leave the encrypted vault."
          action={{ label: "Add a profile", onClick: () => setEditing({ profile: null }) }}
        />
      ) : (
        <div className="flex flex-col gap-3 p-4">
          <Button
            size="sm"
            variant="primary"
            className="self-start"
            onClick={() => setEditing({ profile: null })}
          >
            <Plus size={14} /> Add profile
          </Button>
          <ul className="flex flex-col text-[13px]">
            {snapshot.credentials.map((p) => {
              const parts = [
                p.hasPassword && "password",
                (p.hasKeyData || p.keyPath) && "key",
                p.hasEnableSecret && (p.autoEnable ? "enable (auto)" : "enable"),
              ].filter(Boolean);
              const n = usedBy(p.id);
              return (
                <li
                  key={p.id}
                  className="flex items-center gap-3 border-t border-border/60 py-1.5 first:border-t-0"
                >
                  <KeyRound size={14} className="text-fg-muted" />
                  <button
                    type="button"
                    className="font-medium hover:text-accent-text"
                    onClick={() => setEditing({ profile: p })}
                  >
                    {p.name}
                  </button>
                  <span className="text-fg-muted">{p.username}</span>
                  <span className="text-xs text-fg-subtle">{parts.join(" · ")}</span>
                  <span className="flex-1" />
                  {n > 0 && (
                    <span className="text-xs text-fg-subtle">
                      {n} {n === 1 ? "device" : "devices"}
                    </span>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => void remove(p)}>
                    Delete
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {editing && <CredentialDialog profile={editing.profile} onClose={() => setEditing(null)} />}
    </div>
  );
}
