import { useEffect } from "react";
import { useActions, type Action } from "@/lib/actions";
import type { Snippet } from "@/lib/ipc";
import { snippetPath } from "@/lib/snippets";
import { useBroadcast } from "@/stores/broadcast";
import { useSessions } from "@/stores/sessions";
import { useSnippets } from "@/stores/snippets";
import { useUi } from "@/stores/ui";
import { runSnippet } from "@/terminal/snippetRun";

const hasTerminal = () => {
  const { tabs, activeId } = useSessions.getState();
  return tabs.some((t) => t.id === activeId && t.protocol !== "rdp");
};

const terminalTabs = () => useSessions.getState().tabs.filter((t) => t.protocol !== "rdp");

/** One palette entry per snippet; typed into the active tab. */
export function snippetActions(list: readonly Snippet[]): Action[] {
  return list.map((s) => ({
    id: `snippet.run.${s.id}`,
    title: `Snippet: ${snippetPath(s)}`,
    group: "Snippets",
    keywords: [s.vendor, s.description, s.body.split("\n")[0] ?? ""].filter(Boolean),
    enabled: hasTerminal,
    run: () => runSnippet(s),
  }));
}

const STATIC: Action[] = [
  {
    id: "tools.tftp",
    title: "TFTP server…",
    group: "Tools",
    keywords: ["firmware", "image", "config backup", "upload", "download"],
    run: () => useUi.getState().openTool("tftp"),
  },
  {
    id: "snippets.manage",
    title: "Snippets: Manage library…",
    group: "Snippets",
    keywords: ["commands", "templates", "macros"],
    run: () => useSnippets.getState().openManager(),
  },
  {
    id: "snippets.bar",
    title: "Show or hide snippet bar",
    group: "Snippets",
    shortcut: "Mod+Shift+S",
    keywords: ["toolbar"],
    run: () => {
      const s = useSnippets.getState();
      s.setBarVisible(!s.barVisible);
    },
  },
  {
    id: "broadcast.start",
    title: "Broadcast input to tabs…",
    group: "Sessions",
    shortcut: "Mod+Shift+B",
    keywords: ["multi", "send to all", "cluster"],
    enabled: () => terminalTabs().length >= 2 && useBroadcast.getState().members.length === 0,
    run: () => useBroadcast.getState().setPickerOpen(true),
  },
  {
    id: "broadcast.stop",
    title: "Stop broadcast",
    group: "Sessions",
    shortcut: "Mod+Shift+B",
    enabled: () => useBroadcast.getState().members.length > 0,
    run: () => useBroadcast.getState().stop(),
  },
];

export function useToolActions() {
  const register = useActions((s) => s.register);
  const list = useSnippets((s) => s.list);
  const load = useSnippets((s) => s.load);
  useEffect(() => register(STATIC), [register]);
  useEffect(() => {
    if (list === null) void load();
  }, [list, load]);
  useEffect(() => (list ? register(snippetActions(list)) : undefined), [register, list]);
}
