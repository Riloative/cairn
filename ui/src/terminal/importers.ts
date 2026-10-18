import { ANSI_KEYS, isHexColor, schemeOf, type Palette, type PaletteColors } from "./palette";

/**
 * Parsers for third-party terminal color schemes. Each returns a complete palette or
 * throws an Error with a user-facing message. Parsing never executes or renders input.
 */

export type ImportFormat = "itermcolors" | "ghostty" | "windows-terminal" | "alacritty";

const hex2 = (n: number) =>
  Math.round(Math.min(1, Math.max(0, n)) * 255)
    .toString(16)
    .padStart(2, "0");

function normalizeHex(value: string): string | null {
  const v = value.trim().replace(/^['"]|['"]$/g, "");
  const m = /^(?:#|0x)?([0-9a-f]{6})$/i.exec(v) ?? /^(?:#)?([0-9a-f]{3})$/i.exec(v);
  if (!m?.[1]) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${h.toLowerCase()}`;
}

function complete(partial: Partial<PaletteColors>, name: string, source: string): Palette {
  const missing = ANSI_KEYS.filter((k) => !partial[k]);
  if (missing.length > 0) throw new Error(`The scheme is missing colors: ${missing.join(", ")}.`);
  if (!partial.background || !partial.foreground)
    throw new Error("The scheme has no background or foreground color.");
  const colors = {
    ...partial,
    cursor: partial.cursor ?? partial.foreground,
    selectionBackground: partial.selectionBackground ?? partial.brightBlack ?? partial.foreground,
  } as PaletteColors;
  for (const [k, v] of Object.entries(colors)) {
    if (!isHexColor(v)) throw new Error(`Invalid color for ${k}: ${String(v)}`);
  }
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return {
    id: `custom-${slug || "palette"}`,
    name: name.trim() || "Imported palette",
    scheme: schemeOf(colors.background),
    source,
    license: "imported by user",
    colors,
  };
}

// ── iTerm2 (.itermcolors, XML plist) ──────────────────────────────────────────────

const ITERM_KEYS: Record<string, keyof PaletteColors> = {
  "Background Color": "background",
  "Foreground Color": "foreground",
  "Cursor Color": "cursor",
  "Selection Color": "selectionBackground",
};

export function parseItermColors(xml: string, name: string): Palette {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("This is not a valid .itermcolors file.");
  const root = doc.querySelector("plist > dict");
  if (!root) throw new Error("This is not a valid .itermcolors file.");
  const out: Partial<PaletteColors> = {};
  const children = Array.from(root.children);
  for (let i = 0; i < children.length - 1; i++) {
    const keyEl = children[i];
    const dict = children[i + 1];
    if (keyEl?.tagName !== "key" || dict?.tagName !== "dict") continue;
    const key = keyEl.textContent?.trim() ?? "";
    const ansi = /^Ansi (\d+) Color$/.exec(key);
    const target: keyof PaletteColors | undefined = ansi
      ? ANSI_KEYS[Number(ansi[1])]
      : ITERM_KEYS[key];
    if (!target) continue;
    const comp: Record<string, number> = {};
    const items = Array.from(dict.children);
    for (let j = 0; j < items.length - 1; j++) {
      const k = items[j];
      const v = items[j + 1];
      if (k?.tagName === "key" && (v?.tagName === "real" || v?.tagName === "integer"))
        comp[k.textContent?.trim() ?? ""] = Number(v.textContent);
    }
    const r = comp["Red Component"];
    const g = comp["Green Component"];
    const b = comp["Blue Component"];
    if (r === undefined || g === undefined || b === undefined) continue;
    out[target] = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  }
  return complete(out, name, "iTerm2 import");
}

// ── Ghostty (key = value) ─────────────────────────────────────────────────────────

const GHOSTTY_KEYS: Record<string, keyof PaletteColors> = {
  background: "background",
  foreground: "foreground",
  "cursor-color": "cursor",
  "selection-background": "selectionBackground",
};

export function parseGhostty(text: string, name: string): Palette {
  const out: Partial<PaletteColors> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "palette") {
      const m = /^(\d+)\s*=\s*(.+)$/.exec(value);
      const idx = Number(m?.[1]);
      const color = normalizeHex(m?.[2] ?? "");
      const target = ANSI_KEYS[idx];
      if (target && color) out[target] = color;
    } else if (GHOSTTY_KEYS[key]) {
      const color = normalizeHex(value);
      if (color) out[GHOSTTY_KEYS[key]] = color;
    }
  }
  return complete(out, name, "Ghostty import");
}

// ── Windows Terminal (JSON scheme or settings.json with schemes[]) ────────────────

const WT_KEYS: Record<string, keyof PaletteColors> = {
  background: "background",
  foreground: "foreground",
  cursorColor: "cursor",
  selectionBackground: "selectionBackground",
  black: "black",
  red: "red",
  green: "green",
  yellow: "yellow",
  blue: "blue",
  purple: "magenta",
  magenta: "magenta",
  cyan: "cyan",
  white: "white",
  brightBlack: "brightBlack",
  brightRed: "brightRed",
  brightGreen: "brightGreen",
  brightYellow: "brightYellow",
  brightBlue: "brightBlue",
  brightPurple: "brightMagenta",
  brightMagenta: "brightMagenta",
  brightCyan: "brightCyan",
  brightWhite: "brightWhite",
};

export function parseWindowsTerminal(text: string, fallbackName: string): Palette {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("This is not valid JSON.");
  }
  const scheme =
    data && typeof data === "object" && Array.isArray((data as { schemes?: unknown }).schemes)
      ? (data as { schemes: unknown[] }).schemes[0]
      : data;
  if (!scheme || typeof scheme !== "object") throw new Error("No color scheme found.");
  const s = scheme as Record<string, unknown>;
  const out: Partial<PaletteColors> = {};
  for (const [k, target] of Object.entries(WT_KEYS)) {
    const v = s[k];
    const color = typeof v === "string" ? normalizeHex(v) : null;
    if (color) out[target] = color;
  }
  return complete(
    out,
    typeof s.name === "string" ? s.name : fallbackName,
    "Windows Terminal import",
  );
}

// ── Alacritty (TOML [colors.*] tables) ────────────────────────────────────────────

export function parseAlacritty(text: string, name: string): Palette {
  const out: Partial<PaletteColors> = {};
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header?.[1]) {
      section = header[1].trim();
      continue;
    }
    const kv = /^([A-Za-z_]+)\s*=\s*(.+)$/.exec(line);
    if (!kv?.[1] || !kv[2]) continue;
    const key = kv[1];
    const color = normalizeHex(kv[2]);
    if (!color) continue;
    if (section === "colors.primary" && (key === "background" || key === "foreground"))
      out[key] = color;
    else if (section === "colors.cursor" && key === "cursor") out.cursor = color;
    else if (section === "colors.selection" && key === "background")
      out.selectionBackground = color;
    else if (section === "colors.normal" || section === "colors.bright") {
      const base = key.toLowerCase();
      const k = (
        section === "colors.bright" ? `bright${base[0]?.toUpperCase() ?? ""}${base.slice(1)}` : base
      ) as keyof PaletteColors;
      if ((ANSI_KEYS as readonly string[]).includes(k)) out[k] = color;
    }
  }
  return complete(out, name, "Alacritty import");
}

/** Guess the format from the file name and content. */
export function detectFormat(fileName: string, text: string): ImportFormat {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".itermcolors") || text.includes("<plist")) return "itermcolors";
  if (lower.endsWith(".json") || text.trimStart().startsWith("{")) return "windows-terminal";
  if (lower.endsWith(".toml") || /^\s*\[colors\./m.test(text)) return "alacritty";
  return "ghostty";
}

export function importPalette(fileName: string, text: string): Palette {
  const base = fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
  switch (detectFormat(fileName, text)) {
    case "itermcolors":
      return parseItermColors(text, base);
    case "windows-terminal":
      return parseWindowsTerminal(text, base);
    case "alacritty":
      return parseAlacritty(text, base);
    case "ghostty":
      return parseGhostty(text, base);
  }
}
