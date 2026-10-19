import type { Palette } from "@/terminal/palette";
import { ANSI_KEYS } from "@/terminal/palette";

/** Static terminal mock-up in a palette's colors (palette data, not UI styling). */
export function PalettePreview({
  palette,
  compact = false,
}: {
  palette: Palette;
  compact?: boolean;
}) {
  const c = palette.colors;
  const span = (color: string, text: string, bold = false) => (
    <span style={{ color, fontWeight: bold ? 700 : undefined }}>{text}</span>
  );
  return (
    <div
      className="overflow-hidden rounded-md font-mono text-[11px] leading-[1.45]"
      style={{ background: c.background, color: c.foreground }}
    >
      <div className={compact ? "p-2" : "p-3"}>
        <div>
          {span(c.green, "admin@core-sw1", true)}:{span(c.blue, "~", true)}$ show ip int brief
        </div>
        <div>
          {span(c.blue, "Gi1/0/1", true)} {span(c.brightCyan, "10.0.0.1")} {span(c.green, "up")}{" "}
          {span(c.green, "up")}
        </div>
        <div>
          {span(c.blue, "Gi1/0/2", true)} unassigned {span(c.yellow, "admin down")}{" "}
          {span(c.red, "down")}
        </div>
        {!compact && (
          <>
            <div>
              {span(c.brightRed, "% Invalid input detected")}{" "}
              <span style={{ background: c.selectionBackground }}>selected</span>
            </div>
            <div className="mt-2 flex gap-1">
              {ANSI_KEYS.map((k) => (
                <span
                  key={k}
                  title={k}
                  className="h-3 w-3 rounded-sm"
                  style={{ background: c[k] }}
                />
              ))}
            </div>
            <div className="mt-1">
              $ <span style={{ background: c.cursor, color: c.background }}> </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
