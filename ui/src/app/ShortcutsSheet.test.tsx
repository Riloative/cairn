import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useActions } from "@/lib/actions";
import { useUi } from "@/stores/ui";
import { ShortcutsSheet } from "./ShortcutsSheet";

afterEach(() => {
  cleanup();
  useUi.setState({ shortcutsOpen: false });
  useActions.setState({ actions: new Map() });
});

describe("shortcuts sheet", () => {
  it("lists registered shortcuts by group, toggles once", () => {
    const actions = new Map(
      [
        {
          id: "palette.open",
          title: "Command palette",
          group: "General",
          shortcut: "Mod+K",
          run: () => {},
        },
        {
          id: "b.start",
          title: "Broadcast input to tabs…",
          group: "Sessions",
          shortcut: "Mod+Shift+B",
          run: () => {},
        },
        {
          id: "b.stop",
          title: "Stop broadcast",
          group: "Sessions",
          shortcut: "Mod+Shift+B",
          run: () => {},
        },
        { id: "no.keys", title: "No shortcut", group: "General", run: () => {} },
      ].map((a) => [a.id, a]),
    );
    useActions.setState({ actions });
    render(<ShortcutsSheet />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => useUi.getState().setShortcutsOpen(true));
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(dialog).getByText("Command palette")).toBeVisible();
    expect(within(dialog).getByText("Broadcast input to tabs…")).toBeVisible();
    expect(within(dialog).queryByText("Stop broadcast")).toBeNull();
    expect(within(dialog).queryByText("No shortcut")).toBeNull();
    // Context keys that are not actions are listed too.
    expect(within(dialog).getByText("Full screen")).toBeVisible();
    expect(within(dialog).getByLabelText("Space")).toBeVisible();
  });
});
