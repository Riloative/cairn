import { ArrowRightLeft, Square, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { NativeSelect } from "@/components/ui/NativeSelect";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import { formatBytes } from "@/lib/format";
import type { ForwardKind, ForwardPreset, ForwardSpec } from "@/lib/ipc";
import { useForwards } from "@/stores/forwards";
import { useInventory } from "@/stores/inventory";
import { useSessions, type SessionTab } from "@/stores/sessions";
import { backendSessionId } from "@/terminal/controller";

const KINDS: readonly { value: ForwardKind; label: string }[] = [
  { value: "local", label: "Local (-L)" },
  { value: "remote", label: "Remote (-R)" },
  { value: "dynamic", label: "SOCKS (-D)" },
];

const KIND_HELP: Record<ForwardKind, string> = {
  local: "Listen on this computer; connections go to the destination as seen from the server.",
  remote: "Listen on the server; connections come back to the destination as seen from here.",
  dynamic: "A SOCKS5 proxy on this computer; applications reach anything the server can.",
};

const POLL_MS = 1000;

function connectedSshTabs(tabs: SessionTab[]): { tab: SessionTab; sessionId: string }[] {
  return tabs.flatMap((tab) => {
    const sessionId = backendSessionId(tab.id);
    return tab.protocol === "ssh" && tab.state === "connected" && sessionId
      ? [{ tab, sessionId }]
      : [];
  });
}

function portError(port: number, allowZero: boolean): string | undefined {
  if (!Number.isInteger(port) || port < (allowZero ? 0 : 1) || port > 65535)
    return allowZero ? "Use 0 (any free port) to 65535." : "Use a port from 1 to 65535.";
  return undefined;
}

function NewForward() {
  const tabs = useSessions((s) => s.tabs);
  const preselect = useForwards((s) => s.preselectTab);
  const targets = connectedSshTabs(tabs);
  const [tabId, setTabId] = useState<string>(
    () => targets.find((t) => t.tab.id === preselect)?.tab.id ?? targets[0]?.tab.id ?? "",
  );
  const [spec, setSpec] = useState<ForwardSpec>({
    kind: "local",
    bindHost: "127.0.0.1",
    bindPort: 0,
    destHost: "",
    destPort: 443,
  });
  const [savePreset, setSavePreset] = useState(false);
  const [autoStart, setAutoStart] = useState(true);
  const [touched, setTouched] = useState(false);
  const set = <K extends keyof ForwardSpec>(k: K, v: ForwardSpec[K]) =>
    setSpec({ ...spec, [k]: v });
  const chosen = targets.find((t) => t.tab.id === tabId) ?? targets[0];
  const needsDest = spec.kind !== "dynamic";
  const errors = {
    bind: portError(spec.bindPort, true),
    destHost: needsDest && !spec.destHost.trim() ? "Enter the destination host." : undefined,
    destPort: needsDest ? portError(spec.destPort, false) : undefined,
  };
  const invalid = Object.values(errors).some(Boolean);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!chosen || invalid) return;
    const started = await useForwards.getState().start(chosen.sessionId, spec);
    if (started && savePreset && chosen.tab.device) {
      await useForwards.getState().savePreset({
        ...spec,
        id: 0,
        deviceId: chosen.tab.device.id,
        autoStart,
        description: "",
      });
    }
    if (started) setTouched(false);
  }

  if (targets.length === 0)
    return (
      <p className="rounded-md border border-dashed border-border p-4 text-xs text-fg-subtle">
        Forwards run over an SSH session. Connect to a device over SSH first.
      </p>
    );

  return (
    <form
      aria-label="New port forward"
      className="flex flex-col gap-4"
      onSubmit={(e) => void submit(e)}
      noValidate
    >
      <Field label="Over session">
        <NativeSelect value={chosen?.tab.id ?? ""} onChange={(e) => setTabId(e.target.value)}>
          {targets.map(({ tab }) => (
            <option key={tab.id} value={tab.id}>
              {tab.title}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <div className="flex flex-col gap-1.5">
        <SegmentedControl
          label="Forward type"
          value={spec.kind}
          options={KINDS}
          onChange={(v) => set("kind", v)}
        />
        <p className="text-xs text-fg-muted">{KIND_HELP[spec.kind]}</p>
      </div>
      <div className="grid grid-cols-[1fr_112px] gap-3">
        <Field label={spec.kind === "remote" ? "Listen on (server)" : "Listen on"}>
          <Input
            spellCheck={false}
            value={spec.bindHost}
            onChange={(e) => set("bindHost", e.target.value)}
          />
        </Field>
        <Field label="Port" error={touched ? errors.bind : undefined}>
          <Input
            type="number"
            value={spec.bindPort}
            onChange={(e) => set("bindPort", Math.trunc(Number(e.target.value)))}
          />
        </Field>
      </div>
      {needsDest && (
        <div className="grid grid-cols-[1fr_112px] gap-3">
          <Field label="Destination host" error={touched ? errors.destHost : undefined}>
            <Input
              spellCheck={false}
              placeholder="10.0.0.5"
              value={spec.destHost}
              onChange={(e) => set("destHost", e.target.value)}
            />
          </Field>
          <Field label="Port" error={touched ? errors.destPort : undefined}>
            <Input
              type="number"
              aria-label="Destination port"
              value={spec.destPort}
              onChange={(e) => set("destPort", Math.trunc(Number(e.target.value)))}
            />
          </Field>
        </div>
      )}
      {chosen?.tab.device && (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-[13px]">
          <label className="flex items-center justify-between gap-3">
            Save as preset for {chosen.tab.title}
            <Switch
              checked={savePreset}
              onCheckedChange={setSavePreset}
              aria-label="Save as preset"
            />
          </label>
          {savePreset && (
            <label className="flex items-center justify-between gap-3">
              Start automatically on connect
              <Switch
                checked={autoStart}
                onCheckedChange={setAutoStart}
                aria-label="Start automatically"
              />
            </label>
          )}
        </div>
      )}
      <div>
        <Button type="submit" variant="primary">
          Start forward
        </Button>
      </div>
    </form>
  );
}

function ActiveForwards() {
  const active = useForwards((s) => s.active);
  const tabs = useSessions((s) => s.tabs);
  const tabTitle = (sessionId: string) =>
    tabs.find((t) => backendSessionId(t.id) === sessionId)?.title;
  if (active.length === 0)
    return (
      <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-fg-subtle">
        No port forwards are running.
      </p>
    );
  return (
    <table className="w-full text-[13px]">
      <thead className="text-left text-xs text-fg-muted">
        <tr>
          <th className="py-1 font-medium">Forward</th>
          <th className="py-1 font-medium">Session</th>
          <th className="py-1 text-right font-medium">Connections</th>
          <th className="py-1 text-right font-medium">Traffic</th>
          <th className="w-10" />
        </tr>
      </thead>
      <tbody>
        {active.map((f) => (
          <tr key={f.id} className="border-t border-border align-top">
            <td className="py-2 font-mono text-xs">
              {f.summary}
              {f.counters.lastError && (
                <span className="mt-0.5 block font-sans text-danger">{f.counters.lastError}</span>
              )}
            </td>
            <td className="py-2">{tabTitle(f.sessionId) ?? f.target}</td>
            <td className="py-2 text-right font-mono text-xs">
              {f.counters.active} open · {f.counters.total} total
            </td>
            <td className="py-2 text-right font-mono text-xs">
              ↑ {formatBytes(f.counters.bytesOut)} ↓ {formatBytes(f.counters.bytesIn)}
            </td>
            <td className="py-1.5 text-right">
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Stop ${f.summary}`}
                onClick={() => void useForwards.getState().stop(f.id)}
              >
                <Square size={12} />
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Presets() {
  const presets = useForwards((s) => s.presets);
  const devices = useInventory((s) => s.snapshot?.devices);
  const name = (id: number) => devices?.find((d) => d.id === id)?.hostname ?? `Device ${id}`;
  const summary = (p: ForwardPreset) =>
    p.kind === "dynamic"
      ? `D ${p.bindHost}:${p.bindPort} (SOCKS5)`
      : `${p.kind === "local" ? "L" : "R"} ${p.bindHost}:${p.bindPort} → ${p.destHost}:${p.destPort}`;
  if (!presets || presets.length === 0)
    return (
      <p className="text-xs text-fg-subtle">
        Save a forward as a preset to offer it for a device, or start it whenever you connect.
      </p>
    );
  return (
    <ul className="flex flex-col">
      {presets.map((p) => (
        <li
          key={p.id}
          className="flex items-center gap-3 border-t border-border py-2 text-[13px] first:border-0"
        >
          <span className="w-32 truncate font-medium">{name(p.deviceId)}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{summary(p)}</span>
          <label className="flex items-center gap-2 text-xs text-fg-muted">
            Auto-start
            <Switch
              checked={p.autoStart}
              aria-label={`Auto-start ${summary(p)}`}
              onCheckedChange={(v) =>
                void useForwards.getState().savePreset({ ...p, autoStart: v })
              }
            />
          </label>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Delete preset ${summary(p)}`}
            onClick={() => void useForwards.getState().deletePreset(p.id)}
          >
            <Trash2 size={12} />
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** Port forwards over open SSH sessions, with live counters, and per-device presets. */
export function ForwardsSection() {
  const refresh = useForwards((s) => s.refresh);
  const loadPresets = useForwards((s) => s.loadPresets);
  const preselect = useForwards((s) => s.preselectTab);
  const tabs = useSessions((s) => s.tabs);
  const formKey = useMemo(
    () =>
      `${preselect}:${connectedSshTabs(tabs)
        .map((t) => t.tab.id)
        .join(",")}`,
    [preselect, tabs],
  );

  useEffect(() => {
    void refresh();
    void loadPresets();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, loadPresets]);

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(320px,420px)_1fr]">
      <section className="flex flex-col gap-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ArrowRightLeft size={14} aria-hidden /> New forward
        </h2>
        <NewForward key={formKey} />
      </section>
      <section className="flex min-w-0 flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Running</h2>
          <ActiveForwards />
        </div>
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Presets</h2>
          <Presets />
        </div>
      </section>
    </div>
  );
}
