import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/cn";
import { ANSI_KEYS } from "@/terminal/palette";
import { patternError } from "@/terminal/highlight/engine";
import { BUILTIN_RULESETS } from "@/terminal/highlight/rulesets";
import type { HighlightRule, HighlightRuleSet } from "@/terminal/highlight/types";

const COLOR_OPTIONS = ["", ...ANSI_KEYS];

function ColorSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className="h-7 w-28 rounded-md border border-border bg-surface px-1 text-xs"
    >
      {COLOR_OPTIONS.map((c) => (
        <option key={c} value={c}>
          {c || "—"}
        </option>
      ))}
      {value && !COLOR_OPTIONS.includes(value) && <option value={value}>{value}</option>}
    </select>
  );
}

/**
 * Edit a rule set. Built-in sets are edited as a custom copy with the same id (which then
 * replaces the built-in one); "Reset" removes the copy.
 */
export function HighlightEditor({
  custom,
  onSave,
}: {
  custom: HighlightRuleSet[];
  onSave: (sets: HighlightRuleSet[]) => Promise<void>;
}) {
  const [setId, setSetId] = useState("common");
  const builtin = BUILTIN_RULESETS.find((s) => s.id === setId);
  const stored = custom.find((s) => s.id === setId) ?? builtin;
  const [draft, setDraft] = useState<HighlightRuleSet | null>(null);
  if (!stored) return null;
  const set = draft ?? stored;
  const isCustomized = custom.some((s) => s.id === setId);
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(stored);
  const errors = set.rules.map((r) => (r.enabled ? patternError(r.pattern) : null));

  const updateRule = (i: number, patch: Partial<HighlightRule>) =>
    setDraft({ ...set, rules: set.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });

  async function save() {
    if (!draft || errors.some(Boolean)) return;
    await onSave([...custom.filter((s) => s.id !== draft.id), draft]);
    setDraft(null);
  }

  async function reset() {
    await onSave(custom.filter((s) => s.id !== setId));
    setDraft(null);
  }

  return (
    <div className="flex flex-col gap-3 py-4">
      <div className="flex items-center gap-2">
        <select
          aria-label="Rule set"
          value={setId}
          onChange={(e) => {
            setSetId(e.target.value);
            setDraft(null);
          }}
          className="h-8 rounded-md border border-border bg-surface px-2 text-[13px]"
        >
          {BUILTIN_RULESETS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {custom.some((c) => c.id === s.id) ? " (customized)" : ""}
            </option>
          ))}
        </select>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            setDraft({
              ...set,
              rules: [
                ...set.rules,
                {
                  id: `custom.${crypto.randomUUID().slice(0, 8)}`,
                  name: "New rule",
                  pattern: "",
                  caseInsensitive: false,
                  fg: "yellow",
                  bg: null,
                  bold: false,
                  underline: false,
                  enabled: true,
                },
              ],
            })
          }
        >
          <Plus size={14} /> Add rule
        </Button>
      </div>
      <div className="flex flex-col gap-1.5">
        {set.rules.map((r, i) => (
          <div key={r.id} className="flex flex-col gap-1 rounded-md bg-surface-raised/60 p-2">
            <div className="flex items-center gap-2">
              <Switch
                aria-label={`Enable ${r.name}`}
                checked={r.enabled}
                onCheckedChange={(v) => updateRule(i, { enabled: v })}
              />
              <Input
                aria-label="Rule name"
                className="h-7 w-40 text-xs"
                value={r.name}
                onChange={(e) => updateRule(i, { name: e.target.value })}
              />
              <Input
                aria-label="Pattern"
                spellCheck={false}
                invalid={Boolean(errors[i])}
                className="h-7 flex-1 font-mono text-xs"
                value={r.pattern}
                onChange={(e) => updateRule(i, { pattern: e.target.value })}
              />
              <button
                type="button"
                aria-label={`Delete ${r.name}`}
                onClick={() => setDraft({ ...set, rules: set.rules.filter((_, j) => j !== i) })}
                className="rounded p-1 text-fg-subtle hover:text-danger"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="flex items-center gap-2 pl-11 text-xs text-fg-muted">
              fg{" "}
              <ColorSelect
                label="Foreground"
                value={r.fg}
                onChange={(v) => updateRule(i, { fg: v })}
              />
              bg{" "}
              <ColorSelect
                label="Background"
                value={r.bg}
                onChange={(v) => updateRule(i, { bg: v })}
              />
              {(["bold", "underline", "caseInsensitive"] as const).map((k) => (
                <label key={k} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    className="accent-[var(--accent)]"
                    checked={r[k]}
                    onChange={(e) => updateRule(i, { [k]: e.target.checked })}
                  />
                  {k === "caseInsensitive" ? "ignore case" : k}
                </label>
              ))}
              {errors[i] && <span className={cn("text-danger")}>{errors[i]}</span>}
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        {isCustomized && (
          <Button variant="ghost" onClick={() => void reset()}>
            Reset to built-in
          </Button>
        )}
        <Button variant="ghost" disabled={!dirty} onClick={() => setDraft(null)}>
          Revert
        </Button>
        <Button
          variant="primary"
          disabled={!dirty || errors.some(Boolean)}
          onClick={() => void save()}
        >
          Save rules
        </Button>
      </div>
    </div>
  );
}
