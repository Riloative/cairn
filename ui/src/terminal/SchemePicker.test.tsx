import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { useSessions } from "@/stores/sessions";
import { useTerminalUi } from "@/stores/terminalUi";
import { BUNDLED_PALETTES } from "./palettes";
import { SchemePicker } from "./SchemePicker";

const TAB = { id: "t1", title: "core-sw1", protocol: "ssh", state: "connected" } as const;

function renderPicker() {
  const tab = useSessions.getState().tabs[0];
  if (!tab) throw new Error("no tab");
  return render(
    <TooltipProvider>
      <SchemePicker tab={tab} />
    </TooltipProvider>,
  );
}

describe("SchemePicker", () => {
  beforeEach(() => {
    useSessions.setState({ tabs: [{ ...TAB }], activeId: TAB.id });
    useTerminalUi.setState({ schemePickerOpen: false });
  });

  it("changes only this tab's colour scheme and can return to the profile's", async () => {
    const user = userEvent.setup();
    const target = BUNDLED_PALETTES[3];
    if (!target) throw new Error("palette missing");
    const { rerender } = renderPicker();
    await user.click(screen.getByRole("button", { name: "Colour scheme" }));
    const group = await screen.findByRole("radiogroup", { name: "Colour scheme" });
    expect(within(group).getByRole("radio", { name: /^Profile/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await user.click(within(group).getByRole("radio", { name: target.name }));
    expect(useSessions.getState().tabs[0]?.paletteId).toBe(target.id);

    const tab = useSessions.getState().tabs[0];
    if (!tab) throw new Error("no tab");
    rerender(
      <TooltipProvider>
        <SchemePicker tab={tab} />
      </TooltipProvider>,
    );
    expect(screen.getByRole("radio", { name: target.name })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(screen.getByRole("radio", { name: /^Profile/ }));
    expect(useSessions.getState().tabs[0]?.paletteId).toBeUndefined();
  });

  it("opens from the store (the palette action)", async () => {
    renderPicker();
    useTerminalUi.getState().setSchemePickerOpen(true);
    expect(await screen.findByRole("radiogroup", { name: "Colour scheme" })).toBeVisible();
  });
});
