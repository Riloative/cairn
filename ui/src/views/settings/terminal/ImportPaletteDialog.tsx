import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { importPalette } from "@/terminal/importers";
import type { Palette } from "@/terminal/palette";
import { PalettePreview } from "./PalettePreview";

/** Pick a scheme file, preview it live, then save it as a custom palette. */
export function ImportPaletteDialog({
  open,
  onOpenChange,
  existingIds,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingIds: string[];
  onSave: (p: Palette) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [palette, setPalette] = useState<Palette | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setPalette(null);
    if (file.size > 512 * 1024) {
      setError("That file is too large to be a color scheme.");
      return;
    }
    try {
      setPalette(importPalette(file.name, await file.text()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function save() {
    if (!palette) return;
    let id = palette.id;
    for (let n = 2; existingIds.includes(id); n++) id = `${palette.id}-${n}`;
    onSave({ ...palette, id });
    setPalette(null);
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setPalette(null);
          setError(null);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent
        title="Import a color scheme"
        description="iTerm2 (.itermcolors), Ghostty theme files, Windows Terminal JSON schemes or Alacritty TOML."
      >
        <input
          ref={fileRef}
          type="file"
          accept=".itermcolors,.json,.toml,.conf,.txt,*"
          className="sr-only"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <Button onClick={() => fileRef.current?.click()}>Choose file…</Button>
        {error && (
          <p role="alert" className="mt-3 text-xs text-danger">
            {error}
          </p>
        )}
        {palette && (
          <div className="mt-4 flex flex-col gap-3">
            <Field label="Name">
              <Input
                value={palette.name}
                onChange={(e) => setPalette({ ...palette, name: e.target.value })}
              />
            </Field>
            <PalettePreview palette={palette} />
            <p className="text-xs text-fg-subtle">
              {palette.scheme === "dark" ? "Dark" : "Light"} scheme · {palette.source}
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!palette || !palette.name.trim()} onClick={save}>
            Save palette
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
