import { Copy, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import type { TerminalPrefs, TerminalProfile } from "@/lib/ipc";
import type { Palette } from "@/terminal/palette";
import { validateProfile } from "./validateProfile";

const selectClass = "h-8 w-full rounded-md border border-border bg-surface px-2 text-[13px]";

function numberField(
  label: string,
  value: number,
  onChange: (v: number) => void,
  opts: { min: number; max: number; step?: number; suffix?: string },
) {
  return (
    <Field label={label}>
      <Input
        type="number"
        min={opts.min}
        max={opts.max}
        step={opts.step ?? 1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </Field>
  );
}

/** Terminal profiles: pick, create, duplicate, delete, edit with an explicit save. */
export function ProfileEditor({
  prefs,
  palettes,
  onSave,
}: {
  prefs: TerminalPrefs;
  palettes: readonly Palette[];
  onSave: (patch: Partial<TerminalPrefs>) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState(prefs.defaultProfileId);
  const stored = prefs.profiles.find((p) => p.id === selectedId) ?? prefs.profiles[0];
  const [draft, setDraft] = useState<TerminalProfile | null>(null);
  if (!stored) return null;
  const p = draft ?? stored;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(stored);
  const error = validateProfile(p);
  const set = <K extends keyof TerminalProfile>(k: K, v: TerminalProfile[K]) =>
    setDraft({ ...p, [k]: v });

  const select = (id: string) => {
    setSelectedId(id);
    setDraft(null);
  };

  async function save() {
    if (!draft || error) return;
    await onSave({ profiles: prefs.profiles.map((x) => (x.id === draft.id ? draft : x)) });
    setDraft(null);
  }

  async function add(copyOf?: TerminalProfile) {
    const id = `profile-${crypto.randomUUID().slice(0, 8)}`;
    const base = copyOf ?? prefs.profiles[0];
    if (!base) return;
    const created = { ...base, id, name: copyOf ? `${copyOf.name} copy` : "New profile" };
    await onSave({ profiles: [...prefs.profiles, created] });
    select(id);
  }

  async function remove() {
    if (prefs.profiles.length <= 1) return;
    const rest = prefs.profiles.filter((x) => x.id !== p.id);
    const nextDefault =
      prefs.defaultProfileId === p.id ? (rest[0]?.id ?? "") : prefs.defaultProfileId;
    await onSave({ profiles: rest, defaultProfileId: nextDefault });
    select(nextDefault);
  }

  return (
    <div className="flex flex-col gap-4 py-4">
      <div className="flex items-center gap-2">
        <select
          aria-label="Profile"
          value={p.id}
          onChange={(e) => select(e.target.value)}
          className={`${selectClass} max-w-60`}
        >
          {prefs.profiles.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
              {x.id === prefs.defaultProfileId ? " (default)" : ""}
            </option>
          ))}
        </select>
        <Button size="sm" variant="ghost" onClick={() => void add()} aria-label="New profile">
          <Plus size={14} /> New
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void add(stored)}
          aria-label="Duplicate profile"
        >
          <Copy size={14} /> Duplicate
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={prefs.profiles.length <= 1}
          onClick={() => void remove()}
          aria-label="Delete profile"
        >
          <Trash2 size={14} /> Delete
        </Button>
        <span className="flex-1" />
        {p.id !== prefs.defaultProfileId && (
          <Button size="sm" onClick={() => void onSave({ defaultProfileId: p.id })}>
            Make default
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Field label="Name">
          <Input value={p.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="Palette">
          <select
            value={p.paletteId ?? ""}
            onChange={(e) => set("paletteId", e.target.value || null)}
            className={selectClass}
          >
            <option value="">Follow app theme</option>
            {palettes.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Font family">
          <Input value={p.fontFamily} onChange={(e) => set("fontFamily", e.target.value)} />
        </Field>
        {numberField("Font size", p.fontSize, (v) => set("fontSize", v), { min: 6, max: 48 })}
        {numberField("Line height", p.lineHeight, (v) => set("lineHeight", v), {
          min: 1,
          max: 2,
          step: 0.05,
        })}
        {numberField("Scrollback (lines)", p.scrollback, (v) => set("scrollback", v), {
          min: 100,
          max: 1_000_000,
          step: 1000,
        })}
        <Field label="Cursor">
          <select
            value={p.cursorStyle}
            onChange={(e) => set("cursorStyle", e.target.value as TerminalProfile["cursorStyle"])}
            className={selectClass}
          >
            <option value="block">Block</option>
            <option value="bar">Bar</option>
            <option value="underline">Underline</option>
          </select>
        </Field>
        <Field label="Bell">
          <select
            value={p.bell}
            onChange={(e) => set("bell", e.target.value as TerminalProfile["bell"])}
            className={selectClass}
          >
            <option value="visual">Flash</option>
            <option value="sound">Sound</option>
            <option value="none">Off</option>
          </select>
        </Field>
        <Field label={`Opacity (${Math.round(p.opacity * 100)}%)`}>
          <input
            type="range"
            min={0.5}
            max={1}
            step={0.05}
            value={p.opacity}
            onChange={(e) => set("opacity", Number(e.target.value))}
            className="accent-[var(--accent)]"
          />
        </Field>
        {numberField(
          "Paste delay per line (ms)",
          p.pasteLineDelayMs,
          (v) => set("pasteLineDelayMs", v),
          {
            min: 0,
            max: 5000,
            step: 50,
          },
        )}
        <Field label="Local shell" description="Empty uses your login shell.">
          <Input
            placeholder="/bin/zsh"
            value={p.shell ?? ""}
            onChange={(e) => set("shell", e.target.value.trim() ? e.target.value : null)}
          />
        </Field>
        <div className="flex flex-col justify-end gap-2 pb-1">
          <label className="flex items-center gap-2 text-[13px]">
            <Switch checked={p.cursorBlink} onCheckedChange={(v) => set("cursorBlink", v)} />
            Blinking cursor
          </label>
          <label className="flex items-center gap-2 text-[13px]">
            <Switch checked={p.copyOnSelect} onCheckedChange={(v) => set("copyOnSelect", v)} />
            Copy on select
          </label>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {error && <p className="text-xs text-danger">{error}</p>}
        <span className="flex-1" />
        <Button variant="ghost" disabled={!dirty} onClick={() => setDraft(null)}>
          Revert
        </Button>
        <Button variant="primary" disabled={!dirty || Boolean(error)} onClick={() => void save()}>
          Save profile
        </Button>
      </div>
    </div>
  );
}
