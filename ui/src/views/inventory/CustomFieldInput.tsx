import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { NativeSelect } from "@/components/ui/NativeSelect";
import { Switch } from "@/components/ui/Switch";
import type { CustomField, CustomValue } from "@/lib/ipc";
import { customError } from "./model";

/** The right control for a custom field's type. */
export function CustomFieldInput({
  field,
  value,
  onChange,
}: {
  field: CustomField;
  value: CustomValue | undefined;
  onChange: (v: CustomValue) => void;
}) {
  const error = customError(field, value);
  switch (field.kind) {
    case "boolean":
      return (
        <label className="flex items-center gap-2 text-[13px]">
          <Switch
            checked={value === true}
            onCheckedChange={(v) => onChange(v)}
            aria-label={field.label}
          />
          {field.label}
        </label>
      );
    case "select":
      return (
        <Field label={field.label}>
          <NativeSelect
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value || null)}
          >
            <option value="">—</option>
            {field.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </NativeSelect>
        </Field>
      );
    case "multi-select": {
      const selected = Array.isArray(value) ? value : [];
      return (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-xs font-medium text-fg-muted">{field.label}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {field.options.map((o) => (
              <label key={o} className="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  className="accent-[var(--accent)]"
                  checked={selected.includes(o)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...selected, o]
                      : selected.filter((x) => x !== o);
                    onChange(next.length ? next : null);
                  }}
                />
                {o}
              </label>
            ))}
          </div>
        </fieldset>
      );
    }
    case "number":
      return (
        <Field label={field.label} error={error}>
          <Input
            type="number"
            value={typeof value === "number" ? value : ""}
            onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          />
        </Field>
      );
    case "date":
      return (
        <Field label={field.label} error={error}>
          <Input
            type="date"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value || null)}
          />
        </Field>
      );
    default:
      return (
        <Field label={field.label} error={error}>
          <Input
            spellCheck={field.kind === "text"}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
          />
        </Field>
      );
  }
}
