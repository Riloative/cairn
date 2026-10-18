import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/cn";
import type { LegacyAlgorithm } from "@/lib/ipc";
import { useNotifications } from "@/stores/notifications";
import { VendorField } from "@/connect/VendorField";
import {
  ALL_LEGACY,
  LEGACY_LABELS,
  type AuthChoice,
  type FormErrors,
  type QuickConnectForm,
} from "./buildOptions";
import { parseTarget } from "./parse";

const AUTH_OPTIONS: readonly { value: AuthChoice; label: string }[] = [
  { value: "password", label: "Password" },
  { value: "key", label: "Key file" },
  { value: "agent", label: "SSH agent" },
  { value: "keyboardInteractive", label: "Interactive (OTP)" },
];

interface SshFieldsProps {
  form: QuickConnectForm;
  set: <K extends keyof QuickConnectForm>(k: K, v: QuickConnectForm[K]) => void;
  /** Focus the first field on mount (dialog opened, not a tab switch). */
  autoFocus?: boolean;
  errors: FormErrors;
}

/** SSH tab of the connect dialog. */
export function SshFields({ form, set, errors, autoFocus }: SshFieldsProps) {
  const notifyError = useNotifications((s) => s.notifyError);
  const [advanced, setAdvanced] = useState(false);
  const userInDestination = parseTarget(form.destination)?.user;

  async function browseKey() {
    try {
      const path = await openFileDialog({
        multiple: false,
        directory: false,
        title: "Private key",
      });
      if (typeof path === "string") set("keyPath", path);
    } catch (e) {
      notifyError(e, "Could not open the file picker");
    }
  }

  const toggleLegacy = (alg: LegacyAlgorithm, on: boolean) =>
    set("legacy", on ? [...form.legacy, alg] : form.legacy.filter((a) => a !== alg));

  return (
    <>
      <div className="grid grid-cols-[1fr_180px] gap-3">
        <Field label="Destination" error={errors.destination}>
          <Input
            autoFocus={autoFocus}
            placeholder="admin@10.0.0.1 or core-sw1:2222"
            spellCheck={false}
            autoCapitalize="off"
            value={form.destination}
            onChange={(e) => set("destination", e.target.value)}
          />
        </Field>
        <Field label="Username" error={errors.username}>
          <Input
            spellCheck={false}
            autoCapitalize="off"
            disabled={Boolean(userInDestination)}
            placeholder={userInDestination ?? "admin"}
            value={userInDestination ? "" : form.username}
            onChange={(e) => set("username", e.target.value)}
          />
        </Field>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-fg-muted">Authentication</span>
        <SegmentedControl
          label="Authentication"
          value={form.auth}
          options={AUTH_OPTIONS}
          onChange={(v) => set("auth", v)}
        />
      </div>

      {form.auth === "password" && (
        <Field label="Password" description="Leave empty to be asked when connecting.">
          <Input
            type="password"
            autoComplete="off"
            value={form.password}
            onChange={(e) => set("password", e.target.value)}
          />
        </Field>
      )}
      {form.auth === "key" && (
        <Field
          label="Private key"
          error={errors.keyPath}
          description="ed25519, ECDSA or RSA; encrypted keys ask for the passphrase."
        >
          <div className="flex gap-2">
            <Input
              spellCheck={false}
              placeholder="~/.ssh/id_ed25519"
              value={form.keyPath}
              onChange={(e) => set("keyPath", e.target.value)}
            />
            <Button type="button" onClick={() => void browseKey()}>
              Browse…
            </Button>
          </div>
        </Field>
      )}

      <button
        type="button"
        aria-expanded={advanced}
        onClick={() => setAdvanced((a) => !a)}
        className="flex items-center gap-1 self-start text-xs font-medium text-fg-muted hover:text-fg"
      >
        <ChevronRight
          size={14}
          className={cn("transition-transform duration-150", advanced && "rotate-90")}
        />
        Advanced
        {form.legacy.length > 0 && (
          <span className="ml-1 rounded-sm bg-warning/20 px-1.5 text-warning">legacy</span>
        )}
      </button>

      {advanced && (
        <div className="flex flex-col gap-4 rounded-lg bg-surface-raised/60 p-3">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 flex w-full items-center gap-2 text-xs font-medium text-fg-muted">
              Legacy algorithms
              <span className="flex-1" />
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() =>
                  set("legacy", form.legacy.length === ALL_LEGACY.length ? [] : ALL_LEGACY)
                }
              >
                {form.legacy.length === ALL_LEGACY.length ? "None" : "All"}
              </button>
            </legend>
            {form.legacy.length > 0 && (
              <p className="flex items-center gap-1.5 text-xs text-warning">
                <AlertTriangle size={12} /> Weak algorithms for old Cisco, HP and Aruba gear. Use
                only when needed.
              </p>
            )}
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {ALL_LEGACY.map((alg) => (
                <label key={alg} className="flex items-center gap-2 font-mono text-xs">
                  <input
                    type="checkbox"
                    className="accent-[var(--accent)]"
                    checked={form.legacy.includes(alg)}
                    onChange={(e) => toggleLegacy(alg, e.target.checked)}
                  />
                  {LEGACY_LABELS[alg]}
                </label>
              ))}
            </div>
          </fieldset>
          <VendorField value={form.vendor} onChange={(v) => set("vendor", v)} />
          <Field
            label="Jump hosts"
            error={errors.jumps}
            description="ProxyJump chain, first hop first."
          >
            <Input
              spellCheck={false}
              placeholder="ops@bastion:22, core-jump"
              value={form.jumps}
              onChange={(e) => set("jumps", e.target.value)}
            />
          </Field>
          <Field label="Proxy" error={errors.proxy}>
            <Input
              spellCheck={false}
              placeholder="socks5://127.0.0.1:1080"
              value={form.proxy}
              onChange={(e) => set("proxy", e.target.value)}
            />
          </Field>
          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 text-[13px]">
              <Switch
                checked={form.agentForwarding}
                onCheckedChange={(v) => set("agentForwarding", v)}
                aria-label="Agent forwarding"
              />
              Agent forwarding
            </label>
            <label className="flex items-center gap-2 text-[13px]">
              Keepalive
              <Input
                type="number"
                min={0}
                max={3600}
                className="w-20"
                value={form.keepaliveSecs}
                onChange={(e) => set("keepaliveSecs", Math.max(0, Number(e.target.value) || 0))}
              />
              s
            </label>
          </div>
        </div>
      )}
    </>
  );
}
