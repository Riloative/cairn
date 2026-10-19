import type { Snippet } from "./ipc";

/** `{{name}}` / `{{name:default}}`, as parsed by `cairn_core::tools::snippets`. */
const VARIABLE = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*(?::([^}]*))?\}\}/g;

/** Replace variables with `values`; missing ones fall back to their default. */
export function renderSnippet(body: string, values: Record<string, string>): string {
  return body.replace(VARIABLE, (_, name: string, def: string | undefined) =>
    name in values ? (values[name] ?? "") : (def ?? ""),
  );
}

/** Snippets that apply to a vendor: generic ones plus that vendor's (case-insensitive). */
export function snippetsFor(list: readonly Snippet[], vendor: string | undefined): Snippet[] {
  const v = (vendor ?? "").toLowerCase();
  return list.filter((s) => !s.vendor || s.vendor.toLowerCase() === v);
}

/** "Folder/Sub/Name" label used in the palette and search. */
export function snippetPath(s: Pick<Snippet, "folder" | "name">): string {
  return s.folder ? `${s.folder}/${s.name}` : s.name;
}

/**
 * Keystrokes for inserting a snippet: lines joined with Enter (CR), the last line left
 * for the user to review and submit.
 */
export function snippetLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  return lines.map((l, i) => (i < lines.length - 1 ? `${l}\r` : l));
}

/** Folder tree for the manager: folder path → snippets, folders sorted. */
export function groupByFolder(list: readonly Snippet[]): [string, Snippet[]][] {
  const map = new Map<string, Snippet[]>();
  for (const s of list) map.set(s.folder, [...(map.get(s.folder) ?? []), s]);
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}
