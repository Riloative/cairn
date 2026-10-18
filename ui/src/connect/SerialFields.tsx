import { RefreshCw, Usb } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { NativeSelect } from "@/components/ui/NativeSelect";
import { Switch } from "@/components/ui/Switch";
import * as ipc from "@/lib/ipc";
import type { DataBits, FlowControl, Newline, Parity, PortInfo, StopBits } from "@/lib/ipc";
import { BAUD_PRESETS, pickPort, portName, type SerialErrors, type SerialForm } from "./serialForm";
import { VendorField } from "./VendorField";

interface SerialFieldsProps {
  form: SerialForm;
  set: <K extends keyof SerialForm>(k: K, v: SerialForm[K]) => void;
  /** Focus the first field on mount (dialog opened, not a tab switch). */
  autoFocus?: boolean;
  errors: SerialErrors;
}

const CUSTOM = "__custom__";

const NEWLINES: readonly { value: Newline; label: string }[] = [
  { value: "cr", label: "CR" },
  { value: "lf", label: "LF" },
  { value: "crlf", label: "CR LF" },
];

const RECEIVE: readonly { value: Newline; label: string }[] = [
  { value: "crlf", label: "As received" },
  { value: "lf", label: "LF → new line" },
  { value: "cr", label: "CR → new line" },
];

/** Serial tab of the connect dialog. The port list follows hotplug while it is shown. */
export function SerialFields({ form, set, errors, autoFocus }: SerialFieldsProps) {
  const [ports, setPorts] = useState<PortInfo[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [customPath, setCustomPath] = useState(false);
  const [customBaud, setCustomBaud] = useState(
    !(BAUD_PRESETS as readonly number[]).includes(form.baud),
  );
  const [change, setChange] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    ipc
      .serialPortsWatch((c) => {
        if (!alive) return;
        setPorts(c.ports);
        const plugged = c.added[0];
        const gone = c.removed[0];
        if (plugged) setChange(`${portName(plugged.path)} connected`);
        else if (gone) setChange(`${portName(gone.path)} disconnected`);
      })
      .then((list) => {
        if (alive) setPorts(list);
      })
      .catch((e: unknown) => {
        if (alive) setListError(ipc.CommandError.from(e).message);
      });
    return () => {
      alive = false;
      ipc.serialPortsUnwatch().catch(() => {});
    };
  }, []);

  // Follow hotplug: keep the chosen port while present, otherwise the first adapter.
  useEffect(() => {
    if (!ports || customPath) return;
    const next = pickPort(form.path, ports);
    if (next !== form.path) set("path", next);
  }, [ports, customPath, form.path, set]);

  async function refresh() {
    try {
      setPorts(await ipc.serialPorts());
      setListError(null);
    } catch (e) {
      setListError(ipc.CommandError.from(e).message);
    }
  }

  const known = ports?.some((p) => p.path === form.path) ?? false;
  const portValue = customPath || (!known && form.path) ? CUSTOM : form.path;

  return (
    <>
      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
        <Field
          label="Port"
          error={errors.path ?? listError ?? undefined}
          description={
            change ??
            (ports && ports.length === 0
              ? "No serial ports found. Plug in a console cable; the list updates by itself."
              : undefined)
          }
        >
          <NativeSelect
            autoFocus={autoFocus}
            value={portValue}
            onChange={(e) => {
              if (e.target.value === CUSTOM) {
                setCustomPath(true);
              } else {
                setCustomPath(false);
                set("path", e.target.value);
              }
            }}
          >
            {ports === null && <option value="">Scanning…</option>}
            {ports?.length === 0 && portValue !== CUSTOM && <option value="">No ports</option>}
            {ports?.map((p) => (
              <option key={p.path} value={p.path}>
                {p.label === p.path ? p.path : `${p.label} — ${p.path}`}
              </option>
            ))}
            <option value={CUSTOM}>Other path…</option>
          </NativeSelect>
        </Field>
        <Button
          type="button"
          variant="ghost"
          aria-label="Rescan ports"
          className={errors.path || listError || change || ports?.length === 0 ? "mb-5" : ""}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} />
        </Button>
      </div>
      {portValue === CUSTOM && (
        <Field label="Device path">
          <Input
            spellCheck={false}
            placeholder="/dev/ttyUSB0"
            value={form.path}
            onChange={(e) => set("path", e.target.value)}
          />
        </Field>
      )}
      {ports?.find((p) => p.path === form.path)?.chip && (
        <p className="-mt-2 flex items-center gap-1.5 text-xs text-fg-subtle">
          <Usb size={12} /> {ports.find((p) => p.path === form.path)?.chip}
        </p>
      )}

      <div className="grid grid-cols-3 gap-3">
        <Field label="Baud rate" error={errors.baud}>
          {customBaud ? (
            <Input
              type="number"
              min={50}
              value={form.baud}
              onChange={(e) => set("baud", Math.trunc(Number(e.target.value) || 0))}
            />
          ) : (
            <NativeSelect
              value={String(form.baud)}
              onChange={(e) => {
                if (e.target.value === CUSTOM) setCustomBaud(true);
                else set("baud", Number(e.target.value));
              }}
            >
              {BAUD_PRESETS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
              <option value={CUSTOM}>Other…</option>
            </NativeSelect>
          )}
        </Field>
        <Field label="Data bits">
          <NativeSelect
            value={form.dataBits}
            onChange={(e) => set("dataBits", e.target.value as DataBits)}
          >
            <option value="eight">8</option>
            <option value="seven">7</option>
            <option value="six">6</option>
            <option value="five">5</option>
          </NativeSelect>
        </Field>
        <Field label="Parity">
          <NativeSelect
            value={form.parity}
            onChange={(e) => set("parity", e.target.value as Parity)}
          >
            <option value="none">None</option>
            <option value="even">Even</option>
            <option value="odd">Odd</option>
          </NativeSelect>
        </Field>
        <Field label="Stop bits">
          <NativeSelect
            value={form.stopBits}
            onChange={(e) => set("stopBits", e.target.value as StopBits)}
          >
            <option value="one">1</option>
            <option value="two">2</option>
          </NativeSelect>
        </Field>
        <Field label="Flow control">
          <NativeSelect
            value={form.flowControl}
            onChange={(e) => set("flowControl", e.target.value as FlowControl)}
          >
            <option value="none">None</option>
            <option value="rts-cts">RTS/CTS</option>
            <option value="xon-xoff">XON/XOFF</option>
          </NativeSelect>
        </Field>
        <Field label="Enter sends">
          <NativeSelect
            value={form.transmit}
            onChange={(e) => set("transmit", e.target.value as Newline)}
          >
            {NEWLINES.map((n) => (
              <option key={n.value} value={n.value}>
                {n.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
        <Field label="Received line endings">
          <NativeSelect
            value={form.receive}
            onChange={(e) => set("receive", e.target.value as Newline)}
          >
            {RECEIVE.map((n) => (
              <option key={n.value} value={n.value}>
                {n.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <label className="flex h-8 items-center gap-2 text-[13px]">
          <Switch
            checked={form.localEcho}
            onCheckedChange={(v) => set("localEcho", v)}
            aria-label="Local echo"
          />
          Local echo
        </label>
      </div>
      <VendorField value={form.vendor} onChange={(v) => set("vendor", v)} />
    </>
  );
}
