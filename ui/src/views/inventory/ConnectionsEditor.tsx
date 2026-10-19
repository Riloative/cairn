import { ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/Menu";
import { NativeSelect } from "@/components/ui/NativeSelect";
import { Switch } from "@/components/ui/Switch";
import { BAUD_PRESETS } from "@/connect/serialForm";
import { CONSOLE_SERVERS, consoleTcpPort } from "@/connect/telnetForm";
import type { ConnectionMethod, ConsoleServerKind, LegacyAlgorithm } from "@/lib/ipc";
import { ALL_LEGACY, LEGACY_LABELS } from "@/ssh/buildOptions";
import { RdpSettingsFields } from "@/rdp/RdpSettingsFields";
import { defaultMethod, methodError } from "./model";

type Kind = ConnectionMethod["kind"];

const KINDS: readonly { value: Kind; label: string }[] = [
  { value: "ssh", label: "SSH" },
  { value: "telnet", label: "Telnet" },
  { value: "console-server", label: "Console server" },
  { value: "serial", label: "Serial" },
  { value: "rdp", label: "RDP" },
  { value: "web", label: "Web UI" },
];

function NumberInput({
  value,
  onChange,
  ...props
}: { value: number; onChange: (v: number) => void } & Omit<
  React.ComponentProps<typeof Input>,
  "value" | "onChange"
>) {
  return (
    <Input
      type="number"
      value={Number.isFinite(value) ? value : ""}
      onChange={(e) => onChange(Math.trunc(Number(e.target.value) || 0))}
      {...props}
    />
  );
}

function MethodFields({ m, set }: { m: ConnectionMethod; set: (m: ConnectionMethod) => void }) {
  switch (m.kind) {
    case "ssh":
      return (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-[100px_1fr] gap-3">
            <Field label="Port">
              <NumberInput
                min={1}
                max={65535}
                value={m.port}
                onChange={(port) => set({ ...m, port })}
              />
            </Field>
            <Field label="Username" description="Empty uses the credential profile's.">
              <Input
                spellCheck={false}
                value={m.username}
                onChange={(e) => set({ ...m, username: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Jump hosts" description="ProxyJump chain, e.g. ops@bastion:22.">
            <Input
              spellCheck={false}
              value={m.jumps}
              onChange={(e) => set({ ...m, jumps: e.target.value })}
            />
          </Field>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-xs font-medium text-fg-muted">Legacy algorithms</legend>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {ALL_LEGACY.map((alg: LegacyAlgorithm) => (
                <label key={alg} className="flex items-center gap-2 font-mono text-xs">
                  <input
                    type="checkbox"
                    className="accent-[var(--accent)]"
                    checked={m.legacy.includes(alg)}
                    onChange={(e) =>
                      set({
                        ...m,
                        legacy: e.target.checked
                          ? [...m.legacy, alg]
                          : m.legacy.filter((a) => a !== alg),
                      })
                    }
                  />
                  {LEGACY_LABELS[alg]}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex items-center gap-2 text-[13px]">
            <Switch
              checked={m.agentForwarding}
              onCheckedChange={(v) => set({ ...m, agentForwarding: v })}
              aria-label="Agent forwarding"
            />
            Agent forwarding
          </label>
        </div>
      );
    case "telnet":
      return (
        <div className="flex items-end gap-4">
          <Field label="Port" className="w-28">
            <NumberInput
              min={1}
              max={65535}
              value={m.port}
              onChange={(port) => set({ ...m, port })}
            />
          </Field>
          <label className="flex h-8 items-center gap-2 text-[13px]">
            <Switch
              checked={m.raw}
              onCheckedChange={(raw) => set({ ...m, raw })}
              aria-label="Raw TCP"
            />
            Raw TCP
          </label>
        </div>
      );
    case "console-server": {
      const tcp = consoleTcpPort(m.server, m.port);
      return (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-[1fr_1fr] gap-3">
            <Field label="Console server">
              <Input
                spellCheck={false}
                placeholder="cs1.example.net"
                value={m.host}
                onChange={(e) => set({ ...m, host: e.target.value })}
              />
            </Field>
            <Field label="Type">
              <NativeSelect
                value={m.server}
                onChange={(e) => set({ ...m, server: e.target.value as ConsoleServerKind })}
              >
                {CONSOLE_SERVERS.filter((c) => c.value !== "none").map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
                <option value="custom">Custom (TCP port)</option>
              </NativeSelect>
            </Field>
          </div>
          <div className="flex items-end gap-4">
            <Field
              label={m.server === "custom" ? "TCP port" : "Port number"}
              className="w-32"
              description={tcp !== null && m.server !== "custom" ? `TCP ${tcp}` : undefined}
            >
              <NumberInput min={1} value={m.port} onChange={(port) => set({ ...m, port })} />
            </Field>
            <label className="mb-5 flex h-8 items-center gap-2 text-[13px]">
              <Switch
                checked={m.raw}
                onCheckedChange={(raw) => set({ ...m, raw })}
                aria-label="Raw TCP"
              />
              Raw TCP
            </label>
          </div>
        </div>
      );
    }
    case "serial":
      return (
        <div className="grid grid-cols-[1fr_140px] gap-3">
          <Field label="Device path">
            <Input
              spellCheck={false}
              placeholder="/dev/ttyUSB0"
              value={m.path}
              onChange={(e) => set({ ...m, path: e.target.value })}
            />
          </Field>
          <Field label="Baud rate">
            <NativeSelect
              value={String(m.settings.baud)}
              onChange={(e) =>
                set({ ...m, settings: { ...m.settings, baud: Number(e.target.value) } })
              }
            >
              {[...new Set([...BAUD_PRESETS, m.settings.baud])].map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
      );
    case "rdp":
      return (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-[100px_1fr] gap-3">
            <Field label="Port">
              <NumberInput
                min={1}
                max={65535}
                value={m.port}
                onChange={(port) => set({ ...m, port })}
              />
            </Field>
            <Field label="Username" description="Empty uses the credential profile's.">
              <Input
                spellCheck={false}
                value={m.username}
                onChange={(e) => set({ ...m, username: e.target.value })}
              />
            </Field>
          </div>
          <RdpSettingsFields value={m} set={set} />
          <label className="flex items-center gap-2 text-[13px]">
            <Switch
              checked={m.external}
              onCheckedChange={(external) => set({ ...m, external })}
              aria-label="Open in external client"
            />
            Open in an external client (FreeRDP / the system RDP app)
          </label>
        </div>
      );
    case "web":
      return (
        <Field label="Address">
          <Input
            spellCheck={false}
            value={m.url}
            onChange={(e) => set({ ...m, url: e.target.value })}
          />
        </Field>
      );
  }
}

/** Edit a device's connection methods; the first one is the default. */
export function ConnectionsEditor({
  value,
  onChange,
  mgmtIp,
}: {
  value: ConnectionMethod[];
  onChange: (v: ConnectionMethod[]) => void;
  mgmtIp: string;
}) {
  const update = (i: number, m: ConnectionMethod) =>
    onChange(value.map((x, j) => (j === i ? m : x)));
  return (
    <div className="flex flex-col gap-3">
      {value.map((m, i) => {
        const error = methodError(m);
        return (
          <section
            key={i}
            aria-label={`${KINDS.find((k) => k.value === m.kind)?.label} connection`}
            className="flex flex-col gap-3 rounded-lg bg-surface-raised/60 p-3"
          >
            <header className="flex items-center gap-2">
              <span className="text-[13px] font-medium">
                {KINDS.find((k) => k.value === m.kind)?.label}
              </span>
              {i === 0 && (
                <span className="rounded-sm bg-accent-subtle px-1.5 text-[11px] text-fg">
                  default
                </span>
              )}
              <span className="flex-1" />
              {i > 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => onChange([m, ...value.filter((_, j) => j !== i)])}
                >
                  <ArrowUp size={12} /> Make default
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label="Remove connection"
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              >
                <Trash2 size={12} />
              </Button>
            </header>
            <MethodFields m={m} set={(next) => update(i, next)} />
            {error && (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            )}
          </section>
        );
      })}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="sm" variant="ghost" className="self-start">
            <Plus size={14} /> Add connection
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {KINDS.map((k) => (
            <DropdownMenuItem
              key={k.value}
              onSelect={() => onChange([...value, defaultMethod(k.value, mgmtIp)])}
            >
              {k.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
