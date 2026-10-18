import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { NativeSelect } from "@/components/ui/NativeSelect";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import {
  CONSOLE_SERVERS,
  consoleTcpPort,
  type ConsoleChoice,
  type TelnetErrors,
  type TelnetForm,
} from "./telnetForm";
import { VendorField } from "./VendorField";

interface TelnetFieldsProps {
  form: TelnetForm;
  set: <K extends keyof TelnetForm>(k: K, v: TelnetForm[K]) => void;
  /** Focus the first field on mount (dialog opened, not a tab switch). */
  autoFocus?: boolean;
  errors: TelnetErrors;
}

const MODES = [
  { value: "telnet", label: "Telnet" },
  { value: "raw", label: "Raw TCP" },
] as const;

/** Telnet tab of the connect dialog, including reverse Telnet to console servers. */
export function TelnetFields({ form, set, errors, autoFocus }: TelnetFieldsProps) {
  const consoled = form.console !== "none";
  const tcp = consoled ? consoleTcpPort(form.console, form.consolePort) : null;
  return (
    <>
      <Field
        label={consoled ? "Console server" : "Destination"}
        error={errors.destination}
        description={consoled ? undefined : "Port 23 unless given, e.g. 10.0.0.5:2001."}
      >
        <Input
          autoFocus={autoFocus}
          placeholder={consoled ? "cs1.example.net" : "10.0.0.1 or cs1:2001"}
          spellCheck={false}
          autoCapitalize="off"
          value={form.destination}
          onChange={(e) => set("destination", e.target.value)}
        />
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-fg-muted">Mode</span>
        <SegmentedControl
          label="Mode"
          value={form.raw ? "raw" : "telnet"}
          options={MODES}
          onChange={(v) => set("raw", v === "raw")}
        />
      </div>
      <div className="grid grid-cols-[1fr_140px] gap-3">
        <Field label="Console server type" description="Maps a physical port to its TCP port.">
          <NativeSelect
            value={form.console}
            onChange={(e) => set("console", e.target.value as ConsoleChoice)}
          >
            {CONSOLE_SERVERS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          label="Port number"
          error={errors.consolePort}
          description={tcp !== null ? `TCP ${tcp}` : undefined}
        >
          <Input
            type="number"
            min={1}
            disabled={!consoled}
            value={form.consolePort}
            onChange={(e) => set("consolePort", Math.trunc(Number(e.target.value) || 0))}
          />
        </Field>
      </div>
      <VendorField value={form.vendor} onChange={(v) => set("vendor", v)} />
    </>
  );
}
