import { beforeEach, describe, expect, it } from "vitest";
import { useSessions } from "@/stores/sessions";
import { useUi } from "@/stores/ui";
import { coreActions } from "./useCoreActions";

const byId = (id: string) => {
  const a = coreActions().find((x) => x.id === id);
  if (!a) throw new Error(`no action ${id}`);
  return a;
};

describe("core actions", () => {
  beforeEach(() => {
    useUi.setState({ view: "sessions", paletteOpen: false });
    useSessions.setState({ tabs: [], activeId: null });
  });

  it("has unique ids and shortcuts", () => {
    const actions = coreActions();
    expect(new Set(actions.map((a) => a.id)).size).toBe(actions.length);
    const shortcuts = actions.flatMap((a) => (a.shortcut ? [a.shortcut] : []));
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it("navigates to every section", () => {
    for (const view of ["inventory", "map", "audit", "settings", "sessions"] as const) {
      void byId(`view.${view}`).run();
      expect(useUi.getState().view).toBe(view);
    }
  });

  it("toggles the palette", () => {
    void byId("palette.open").run();
    expect(useUi.getState().paletteOpen).toBe(true);
    void byId("palette.open").run();
    expect(useUi.getState().paletteOpen).toBe(false);
  });

  it("hides tab actions without tabs", () => {
    expect(byId("tabs.close").enabled?.()).toBe(false);
    useSessions.getState().open({ id: "a", title: "a", protocol: "local", state: "connected" });
    expect(byId("tabs.close").enabled?.()).toBe(true);
    void byId("tabs.close").run();
    expect(useSessions.getState().tabs).toHaveLength(0);
  });
});

describe("terminal-scoped shortcuts", () => {
  it("are marked so text fields keep their own copy/paste", async () => {
    const { isTypingInField } = await import("./useGlobalShortcuts");
    for (const id of ["terminal.copy", "terminal.paste", "terminal.find"]) {
      expect(byId(id).scope).toBe("terminal");
    }
    const input = document.createElement("input");
    expect(isTypingInField(input)).toBe(true);
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const helper = document.createElement("textarea");
    xterm.appendChild(helper);
    expect(isTypingInField(helper)).toBe(false);
    expect(isTypingInField(document.createElement("div"))).toBe(false);
  });
});
