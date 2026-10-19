import { Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import type { CustomPaletteDto, TerminalPrefs } from "@/lib/ipc";
import { useNotifications } from "@/stores/notifications";
import { customPalettes, useTerminalPrefs } from "@/stores/terminalPrefs";
import type { Palette } from "@/terminal/palette";
import { BUNDLED_PALETTES } from "@/terminal/palettes";
import { HighlightEditor } from "./HighlightEditor";
import { ImportPaletteDialog } from "./ImportPaletteDialog";
import { PalettePreview } from "./PalettePreview";
import { ProfileEditor } from "./ProfileEditor";
import { PromptPatterns } from "./PromptPatterns";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border last:border-0">
      <h2 className="pt-5 text-[13px] font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function TerminalSettings() {
  const prefs = useTerminalPrefs((s) => s.prefs);
  const loaded = useTerminalPrefs((s) => s.loaded);
  const updatePrefs = useTerminalPrefs((s) => s.update);
  const notify = useNotifications((s) => s.notify);
  const notifyError = useNotifications((s) => s.notifyError);
  const [importing, setImporting] = useState(false);

  if (!loaded) return <Skeleton className="mt-4 h-48" />;

  const save = async (patch: Partial<TerminalPrefs>) => {
    try {
      await updatePrefs(patch);
    } catch (e) {
      notifyError(e, "Could not save terminal settings");
      throw e;
    }
  };
  const custom = customPalettes(prefs);
  const allPalettes: Palette[] = [...BUNDLED_PALETTES, ...custom];

  return (
    <div>
      <Section title="Profiles">
        <ProfileEditor prefs={prefs} palettes={allPalettes} onSave={save} />
      </Section>

      <Section title="Palettes">
        <div className="flex items-center justify-between py-2">
          <p className="text-xs text-fg-muted">
            {BUNDLED_PALETTES.length} bundled (MIT, see licenses/terminal-palettes.txt) ·{" "}
            {custom.length} imported. Choose one per profile.
          </p>
          <Button size="sm" onClick={() => setImporting(true)}>
            <Upload size={14} /> Import…
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-3 pb-5">
          {allPalettes.map((p) => (
            <div key={p.id} className="group relative flex flex-col gap-1">
              <PalettePreview palette={p} compact />
              <div className="flex items-center gap-1 text-xs">
                <span className="flex-1 truncate">{p.name}</span>
                {p.id.startsWith("custom-") && (
                  <button
                    type="button"
                    aria-label={`Delete ${p.name}`}
                    onClick={() =>
                      void save({
                        customPalettes: prefs.customPalettes.filter((x) => x.id !== p.id),
                        profiles: prefs.profiles.map((x) =>
                          x.paletteId === p.id ? { ...x, paletteId: null } : x,
                        ),
                      })
                    }
                    className="rounded p-0.5 text-fg-subtle opacity-0 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        <ImportPaletteDialog
          open={importing}
          onOpenChange={setImporting}
          existingIds={allPalettes.map((p) => p.id)}
          onSave={(p) =>
            void save({
              customPalettes: [...prefs.customPalettes, p as unknown as CustomPaletteDto],
            }).then(() => notify({ title: `Imported ${p.name}`, variant: "success" }))
          }
        />
      </Section>

      <Section title="Paste">
        <div className="flex items-center gap-6 py-4">
          <div className="flex-1">
            <p className="font-medium">Confirm multi-line pastes</p>
            <p className="text-xs text-fg-muted">
              Show the line count and a preview before pasting more than one line.
            </p>
          </div>
          <Switch
            aria-label="Confirm multi-line pastes"
            checked={prefs.confirmMultilinePaste}
            onCheckedChange={(v) => void save({ confirmMultilinePaste: v })}
          />
        </div>
      </Section>

      <Section title="Session header">
        <PromptPatterns
          patterns={prefs.privilegedPromptPatterns}
          onSave={(privilegedPromptPatterns) => save({ privilegedPromptPatterns })}
        />
      </Section>

      <Section title="Keyword highlighting">
        <div className="flex items-center gap-6 pt-4">
          <p className="flex-1 text-xs text-fg-muted">
            Colors interface names, addresses, VLANs and states. Display only: logs and recordings
            stay raw. The device vendor picks the rule set.
          </p>
          <Switch
            aria-label="Keyword highlighting"
            checked={prefs.highlightEnabled}
            onCheckedChange={(v) => void save({ highlightEnabled: v })}
          />
        </div>
        <HighlightEditor
          custom={prefs.highlightSets}
          onSave={(highlightSets) => save({ highlightSets })}
        />
      </Section>
    </div>
  );
}
