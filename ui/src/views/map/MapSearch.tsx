import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/Input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/Popover";
import { cn } from "@/lib/cn";
import type { InventorySnapshot } from "@/lib/ipc";
import { Glyph } from "@/map/Glyph";
import { useMap } from "@/stores/map";
import { useMapUi } from "./mapUi";
import { locate, whereLabel } from "./navigation";

/** Find a device anywhere and jump to it on the map. */
export function MapSearch({ inv }: { inv: InventorySnapshot }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return inv.devices
      .filter((d) => {
        const text = `${d.hostname} ${d.mgmtIp} ${d.model} ${d.tags.join(" ")}`.toLowerCase();
        return words.every((w) => text.includes(w));
      })
      .slice(0, 8);
  }, [q, inv.devices]);

  function go(index: number) {
    const d = results[index];
    if (!d) return;
    useMap.getState().setView(locate(d, inv));
    useMapUi.getState().setFocus(d.id);
    setQ("");
  }

  return (
    <Popover open={results.length > 0}>
      <PopoverAnchor asChild>
        <div className="relative w-56">
          <Search
            size={13}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-subtle"
          />
          <Input
            aria-label="Find on map"
            placeholder="Find device…"
            className="h-7 pl-8 text-xs"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") setActive((i) => Math.min(results.length - 1, i + 1));
              else if (e.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
              else if (e.key === "Enter") go(active);
              else if (e.key === "Escape") setQ("");
              else return;
              e.preventDefault();
            }}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-72 p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <ul role="listbox" aria-label="Devices">
          {results.map((d, i) => (
            <li key={d.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(i)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-raised",
                  i === active && "bg-accent-subtle",
                )}
              >
                <Glyph type={d.deviceType} size={16} className="text-fg-muted" />
                <span className="font-medium">{d.hostname}</span>
                <span className="ml-auto truncate text-xs text-fg-subtle">
                  {whereLabel(d, inv)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
