import { ListPlus, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { NativeSelect } from "@/components/ui/NativeSelect";
import * as ipc from "@/lib/ipc";
import type { CustomField, FieldKind, InventorySnapshot } from "@/lib/ipc";
import { confirmAction } from "@/stores/confirm";
import { FIELD_KINDS } from "./labels";
import { mutate } from "./mutate";

const BLANK: CustomField = { id: 0, key: "", label: "", kind: "text", options: [], position: 0 };

function FieldDialog({ initial, onClose }: { initial: CustomField; onClose: () => void }) {
  const [f, setF] = useState(initial);
  const [options, setOptions] = useState(initial.options.join("\n"));
  const [touched, setTouched] = useState(false);
  const needsOptions = f.kind === "select" || f.kind === "multi-select";
  const optionList = options
    .split("\n")
    .map((o) => o.trim())
    .filter(Boolean);
  const labelError = touched && !f.label.trim() ? "Enter a name." : undefined;
  const optionsError =
    touched && needsOptions && optionList.length === 0 ? "Add at least one option." : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!f.label.trim() || (needsOptions && optionList.length === 0)) return;
    const saved = await mutate(
      () => ipc.fieldSave({ ...f, options: needsOptions ? optionList : [] }),
      { error: "Could not save the field" },
    );
    if (saved) onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={initial.id ? `Edit ${initial.label}` : "New custom field"}
        description="Custom fields appear in the device form, the table, filters and search."
      >
        <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
          <Field label="Name" error={labelError}>
            <Input
              autoFocus
              value={f.label}
              onChange={(e) => setF({ ...f, label: e.target.value })}
            />
          </Field>
          <Field
            label="Type"
            description={initial.id ? "The type cannot change once the field exists." : undefined}
          >
            <NativeSelect
              disabled={initial.id !== 0}
              value={f.kind}
              onChange={(e) => setF({ ...f, kind: e.target.value as FieldKind })}
            >
              {FIELD_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {needsOptions && (
            <Field label="Options" description="One per line." error={optionsError}>
              <textarea
                rows={4}
                className="rounded-md border border-border bg-surface p-2.5 text-[13px] focus-visible:border-ring focus-visible:outline-none"
                value={options}
                onChange={(e) => setOptions(e.target.value)}
              />
            </Field>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              {initial.id ? "Save" : "Add field"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function FieldsSection({ snapshot }: { snapshot: InventorySnapshot }) {
  const [editing, setEditing] = useState<CustomField | null>(null);

  async function remove(f: CustomField) {
    const ok = await confirmAction({
      title: `Delete the field ${f.label}?`,
      description: "Its values are removed from every device. This is recorded in the audit log.",
      confirmLabel: "Delete field",
      destructive: true,
    });
    if (ok) await mutate(() => ipc.fieldDelete(f.id), { error: `Could not delete ${f.label}` });
  }

  return (
    <div className="flex h-full flex-col">
      {snapshot.fields.length === 0 ? (
        <EmptyState
          icon={<ListPlus size={20} />}
          title="No custom fields"
          description="Add your own device attributes such as asset tag, owner, warranty end or PoE budget."
          action={{ label: "Add a field", onClick: () => setEditing(BLANK) }}
        />
      ) : (
        <div className="flex flex-col gap-3 p-4">
          <Button
            size="sm"
            variant="primary"
            className="self-start"
            onClick={() => setEditing(BLANK)}
          >
            <Plus size={14} /> Add field
          </Button>
          <ul className="flex flex-col text-[13px]">
            {snapshot.fields.map((f) => (
              <li
                key={f.id}
                className="flex items-center gap-3 border-t border-border/60 py-1.5 first:border-t-0"
              >
                <button
                  type="button"
                  className="font-medium hover:text-accent"
                  onClick={() => setEditing(f)}
                >
                  {f.label}
                </button>
                <span className="font-mono text-xs text-fg-subtle">{f.key}</span>
                <span className="text-fg-muted">
                  {FIELD_KINDS.find((k) => k.value === f.kind)?.label}
                  {f.options.length > 0 && `: ${f.options.join(", ")}`}
                </span>
                <span className="flex-1" />
                <Button size="sm" variant="ghost" onClick={() => void remove(f)}>
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {editing && <FieldDialog initial={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
