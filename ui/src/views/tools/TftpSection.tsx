import { open } from "@tauri-apps/plugin-dialog";
import { ArrowDownToLine, ArrowUpFromLine, FolderOpen, Info } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { NativeSelect } from "@/components/ui/NativeSelect";
import { Skeleton } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/cn";
import * as ipc from "@/lib/ipc";
import type { LocalAddress, TftpLogEntry, TftpPrefs } from "@/lib/ipc";
import { formatBytes } from "@/lib/format";
import { useTftp, watchTftp } from "@/stores/tftp";

const STATE_CLASS: Record<TftpLogEntry["state"], string> = {
  running: "text-accent",
  done: "text-success",
  failed: "text-danger",
  refused: "text-warning",
};

function Toggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4 text-[13px]">
      <span>
        {label}
        {description && <span className="block text-xs text-fg-muted">{description}</span>}
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}

/** Copy-paste example for the device side, using the listening address. */
function example(prefs: TftpPrefs, address: string | null): string {
  const host = (address ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  const ip = !host || host === "0.0.0.0" || host === "::" ? "<this-computer>" : host;
  const port = prefs.port === 69 ? "" : `:${prefs.port}`;
  return `copy tftp://${ip}${port}/<file> flash:`;
}

function Log({ entries }: { entries: TftpLogEntry[] }) {
  if (entries.length === 0)
    return (
      <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-fg-subtle">
        Transfers appear here as devices connect.
      </p>
    );
  return (
    <table className="w-full text-[13px]">
      <thead className="text-left text-xs text-fg-muted">
        <tr>
          <th className="py-1 font-medium">Time</th>
          <th className="py-1 font-medium">Device</th>
          <th className="py-1 font-medium">File</th>
          <th className="py-1 text-right font-medium">Size</th>
          <th className="py-1 pl-3 font-medium">Status</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e, i) => {
          const pct = e.size ? Math.min(100, Math.round((e.bytes / e.size) * 100)) : null;
          return (
            <tr key={`${e.id}-${i}`} className="border-t border-border">
              <td className="py-1.5 font-mono text-xs text-fg-muted">
                {new Date(e.at).toLocaleTimeString()}
              </td>
              <td className="py-1.5 font-mono text-xs">{e.peer}</td>
              <td className="max-w-64 truncate py-1.5">
                {e.direction === "read" ? (
                  <ArrowUpFromLine
                    size={12}
                    className="mr-1 inline text-fg-subtle"
                    aria-label="Sent to device"
                  />
                ) : (
                  <ArrowDownToLine
                    size={12}
                    className="mr-1 inline text-fg-subtle"
                    aria-label="Received from device"
                  />
                )}
                {e.file}
              </td>
              <td className="py-1.5 text-right font-mono text-xs">
                {formatBytes(e.bytes)}
                {e.size !== null && e.state === "running" && ` / ${formatBytes(e.size)}`}
              </td>
              <td className={cn("py-1.5 pl-3 text-xs", STATE_CLASS[e.state])}>
                {e.state === "running" && pct !== null ? `${pct}%` : e.state}
                {e.error && <span className="block text-fg-muted">{e.error}</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Form({ initial, running }: { initial: TftpPrefs; running: boolean }) {
  const [prefs, setPrefs] = useState(initial);
  const [addresses, setAddresses] = useState<LocalAddress[]>([]);
  const busy = useTftp((s) => s.busy);
  const set = <K extends keyof TftpPrefs>(k: K, v: TftpPrefs[K]) => setPrefs({ ...prefs, [k]: v });
  const portError =
    !Number.isInteger(prefs.port) || prefs.port < 1 || prefs.port > 65535
      ? "Use a port from 1 to 65535."
      : undefined;

  useEffect(() => {
    ipc.localAddresses().then(setAddresses, () => setAddresses([]));
  }, []);

  async function pickRoot() {
    const dir = await open({ directory: true, title: "Folder to serve over TFTP" });
    if (typeof dir === "string") set("root", dir);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (running) void useTftp.getState().stop();
    else if (!portError && prefs.root) void useTftp.getState().start(prefs);
  }

  const options = [
    { value: "0.0.0.0", label: "All IPv4 interfaces (0.0.0.0)" },
    { value: "::", label: "All interfaces, IPv6 too (::)" },
    ...addresses.map((a) => ({ value: a.address, label: `${a.address} (${a.interface})` })),
  ];
  if (!options.some((o) => o.value === prefs.bindHost))
    options.push({ value: prefs.bindHost, label: prefs.bindHost });

  return (
    <form aria-label="TFTP server" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <Field label="Folder" description="Devices can only reach files inside this folder.">
        <div className="flex gap-2">
          <Input readOnly value={prefs.root} placeholder="Choose a folder…" className="flex-1" />
          <Button
            type="button"
            variant="secondary"
            disabled={running}
            onClick={() => void pickRoot()}
          >
            <FolderOpen size={14} /> Choose…
          </Button>
        </div>
      </Field>
      <div className="grid grid-cols-[1fr_128px] gap-3">
        <Field label="Listen on">
          <NativeSelect
            disabled={running}
            value={prefs.bindHost}
            onChange={(e) => set("bindHost", e.target.value)}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Port" error={portError}>
          <Input
            type="number"
            min={1}
            max={65535}
            disabled={running}
            value={prefs.port}
            onChange={(e) => set("port", Math.trunc(Number(e.target.value)))}
          />
        </Field>
      </div>
      {prefs.port < 1024 && (
        <p className="flex gap-2 rounded-md bg-surface-raised p-3 text-xs text-fg-muted">
          <Info size={14} className="mt-px shrink-0" aria-hidden />
          <span>
            Ports below 1024 need privileges on Linux. Use a high port such as 6969 (devices accept{" "}
            <code className="font-mono">tftp://host:6969/file</code>), or once run{" "}
            <code className="font-mono select-text">
              sudo setcap 'cap_net_bind_service=+ep' $(command -v cairn)
            </code>{" "}
            (or start Cairn through authbind).
          </span>
        </p>
      )}
      <div className="flex flex-col gap-3 rounded-md border border-border p-3">
        <Toggle
          label="Allow downloads"
          description="Devices may read files (firmware images, configs to load)."
          checked={prefs.allowRead}
          disabled={running}
          onChange={(v) => set("allowRead", v)}
        />
        <Toggle
          label="Allow uploads"
          description="Devices may write files (config backups)."
          checked={prefs.allowWrite}
          disabled={running}
          onChange={(v) => set("allowWrite", v)}
        />
        <Toggle
          label="Replace existing files"
          checked={prefs.overwrite}
          disabled={running || !prefs.allowWrite}
          onChange={(v) => set("overwrite", v)}
        />
      </div>
      <div className="flex items-center gap-3">
        <Button
          type="submit"
          variant={running ? "secondary" : "primary"}
          disabled={
            busy ||
            (!running && (!prefs.root || !!portError || (!prefs.allowRead && !prefs.allowWrite)))
          }
        >
          {running ? "Stop server" : "Start server"}
        </Button>
        {!prefs.root && !running && (
          <span className="text-xs text-fg-subtle">Choose a folder to start.</span>
        )}
      </div>
    </form>
  );
}

export function TftpSection() {
  const status = useTftp((s) => s.status);
  const load = useTftp((s) => s.load);

  useEffect(() => {
    void load();
    const unlisten = watchTftp();
    return () => void unlisten.then((f) => f());
  }, [load]);

  if (!status)
    return (
      <div className="flex flex-col gap-3" aria-busy>
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    );

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(320px,420px)_1fr]">
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={cn("size-2 rounded-full", status.running ? "bg-success" : "bg-fg-subtle")}
          />
          <h2 className="text-sm font-semibold">
            {status.running ? `Serving on ${status.address}` : "TFTP server is off"}
          </h2>
        </div>
        {status.running && (
          <code className="rounded-md bg-surface-raised px-2 py-1.5 font-mono text-xs select-text">
            {example(status.prefs, status.address)}
          </code>
        )}
        <Form key={String(status.running)} initial={status.prefs} running={status.running} />
      </section>
      <section className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center">
          <h2 className="flex-1 text-sm font-semibold">Transfers</h2>
          {status.log.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => void useTftp.getState().clearLog()}>
              Clear
            </Button>
          )}
        </div>
        <Log entries={status.log} />
      </section>
    </div>
  );
}
