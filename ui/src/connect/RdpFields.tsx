import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { RdpSettingsFields } from "@/rdp/RdpSettingsFields";
import type { RdpErrors, RdpForm } from "./rdpForm";

interface RdpFieldsProps {
  form: RdpForm;
  setForm: (form: RdpForm) => void;
  /** Focus the first field on mount (dialog opened, not a tab switch). */
  autoFocus?: boolean;
  errors: RdpErrors;
}

/** RDP tab of the connect dialog. */
export function RdpFields({ form, setForm, errors, autoFocus }: RdpFieldsProps) {
  return (
    <>
      <div className="grid grid-cols-[1fr_200px] gap-3">
        <Field
          label="Destination"
          error={errors.destination}
          description="Port 3389 unless given, e.g. srv1:3390."
        >
          <Input
            autoFocus={autoFocus}
            spellCheck={false}
            placeholder="10.0.0.20 or admin@srv1"
            value={form.destination}
            onChange={(e) => setForm({ ...form, destination: e.target.value })}
          />
        </Field>
        <Field label="Username" error={errors.username}>
          <Input
            spellCheck={false}
            placeholder="Administrator"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Password" description="Leave empty to be asked when connecting.">
        <Input
          type="password"
          autoComplete="off"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
      </Field>
      <RdpSettingsFields value={form} set={setForm} />
    </>
  );
}
