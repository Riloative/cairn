import { Check, Palette as PaletteIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import type { SessionTab } from "@/stores/sessions";
import { customPalettes, profileById, useTerminalPrefs } from "@/stores/terminalPrefs";
import { useTerminalUi } from "@/stores/terminalUi";
import { focusActiveTerminal, paletteFor, profileIdOf, setTabPalette } from "./controller";
import type { Palette } from "./palette";
import { BUNDLED_PALETTES } from "./palettes";

const DOTS = ["red", "green", "yellow", "blue", "magenta", "cyan"] as const;

/** A small tile in a palette's own colours (palette data, not UI styling). */
function SchemeTile({
  palette,
  label,
  selected,
  onSelect,
}: {
  palette: Palette;
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const c = palette.colors;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      onClick={onSelect}
      className={cn(
        "flex flex-col gap-1 rounded-lg p-1 text-left transition-colors duration-150 hover:bg-surface",
        selected && "ring-2 ring-accent",
      )}
    >
      <span
        className="relative flex h-12 flex-col justify-between rounded-md p-1.5 font-mono text-[11px]"
        style={{ background: c.background, color: c.foreground }}
      >
        <span>
          <span style={{ color: c.green }}>$</span> ls
        </span>
        <span className="flex gap-0.5">
          {DOTS.map((k) => (
            <span key={k} className="size-1.5 rounded-full" style={{ background: c[k] }} />
          ))}
        </span>
        {selected && (
          <Check
            size={12}
            className="absolute top-1 right-1"
            style={{ color: c.foreground }}
            aria-hidden
          />
        )}
      </span>
      <span className="truncate px-0.5 text-[11px] text-fg-muted">{label}</span>
    </button>
  );
}

/**
 * Change the active terminal's colour scheme on the spot, like Ptyxis's palette menu.
 * The choice applies to this tab only; "Use for new tabs" saves it to the profile.
 */
export function SchemePicker({ tab }: { tab: SessionTab }) {
  const open = useTerminalUi((s) => s.schemePickerOpen);
  const setOpen = useTerminalUi((s) => s.setSchemePickerOpen);
  const prefs = useTerminalPrefs((s) => s.prefs);
  const update = useTerminalPrefs((s) => s.update);
  if (tab.protocol === "rdp") return null;

  const profile = profileById(prefs, profileIdOf(tab.id));
  const palettes = [...BUNDLED_PALETTES, ...customPalettes(prefs)];
  const choose = (id: string | null) => setTabPalette(tab.id, id);
  const useForNewTabs = () => {
    const id = tab.paletteId ?? null;
    void update({
      profiles: prefs.profiles.map((p) => (p.id === profile.id ? { ...p, paletteId: id } : p)),
    }).then(() => setTabPalette(tab.id, null));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip label="Colour scheme">
        <PopoverTrigger asChild>
          <Button size="sm" variant="ghost" aria-label="Colour scheme">
            <PaletteIcon size={13} />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        align="end"
        className="w-[340px] p-3"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          focusActiveTerminal();
        }}
      >
        <div role="radiogroup" aria-label="Colour scheme" className="flex flex-col gap-2">
          <div className="max-h-[50vh] overflow-y-auto">
            <div className="grid grid-cols-3 gap-1">
              <SchemeTile
                palette={paletteFor(profile)}
                label={`Profile (${profile.name})`}
                selected={!tab.paletteId}
                onSelect={() => choose(null)}
              />
              {palettes.map((p) => (
                <SchemeTile
                  key={p.id}
                  palette={p}
                  label={p.name}
                  selected={tab.paletteId === p.id}
                  onSelect={() => choose(p.id)}
                />
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 border-t border-border pt-2">
            <p className="flex-1 text-[11px] text-fg-muted">Applies to this tab only.</p>
            <Button size="sm" variant="ghost" disabled={!tab.paletteId} onClick={useForNewTabs}>
              Use for new tabs
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
