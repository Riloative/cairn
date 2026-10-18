import { Field } from "@/components/ui/Field";
import { NativeSelect } from "@/components/ui/NativeSelect";
import { VENDORS } from "@/terminal/highlight/rulesets";

/** Highlighting vendor picker shared by the connect dialog tabs. */
export function VendorField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Vendor" description="Selects keyword highlighting for this session.">
      <NativeSelect value={value} onChange={(e) => onChange(e.target.value)}>
        {VENDORS.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}
