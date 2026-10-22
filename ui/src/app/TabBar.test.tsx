import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { useSavedConnections } from "@/stores/savedConnections";
import { useSessions, type SessionTab } from "@/stores/sessions";
import { useUi } from "@/stores/ui";
import { closeTab, openLocalShell } from "@/terminal/controller";
import { TabBar } from "./TabBar";

vi.mock("@/terminal/controller", () => ({
  closeTab: vi.fn((id: string) => useSessions.getState().close(id)),
  openLocalShell: vi.fn(),
  reconnectTab: vi.fn(),
  canReconnect: vi.fn(() => false),
  openSsh: vi.fn(),
  openTelnet: vi.fn(),
  openSerial: vi.fn(),
}));
vi.mock("@/rdp/controller", () => ({ reconnectRdp: vi.fn(), openRdp: vi.fn() }));

const tab = (id: string, protocol: SessionTab["protocol"] = "ssh"): SessionTab => ({
  id,
  title: id,
  protocol,
  state: "connected",
});

function renderBar() {
  return render(
    <TooltipProvider>
      <TabBar />
    </TooltipProvider>,
  );
}

const titles = () => useSessions.getState().tabs.map((t) => t.id);

beforeEach(() => {
  useSessions.setState({ tabs: [tab("a"), tab("b"), tab("c", "local")], activeId: "a" });
  useUi.setState({ view: "sessions", paletteOpen: false, quickConnectOpen: false });
  useSavedConnections.setState({
    list: [
      {
        id: 1,
        name: "core-sw1",
        protocol: "ssh",
        settings: { destination: "admin@10.0.0.1" },
        credentialId: null,
        lastUsedAt: null,
      },
    ],
  });
  vi.mocked(openLocalShell).mockClear();
  vi.mocked(closeTab).mockClear();
});

describe("tab bar", () => {
  it("+ offers a local shell, each protocol and saved connections", async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole("button", { name: "New session" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Local shell/ })).toBeVisible();
    expect(within(menu).getByRole("menuitem", { name: /core-sw1/ })).toBeVisible();
    await user.click(within(menu).getByRole("menuitem", { name: /Serial console/ }));
    expect(useUi.getState()).toMatchObject({ quickConnectOpen: true, connectProtocol: "serial" });

    await user.click(screen.getByRole("button", { name: "New session" }));
    await user.click(await screen.findByRole("menuitem", { name: /Local shell/ }));
    expect(openLocalShell).toHaveBeenCalledTimes(1);
  });

  it("the magnifier opens the command search", async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(useUi.getState().paletteOpen).toBe(true);
  });

  it("right-click closes other tabs or the ones to the right", async () => {
    const user = userEvent.setup();
    renderBar();
    fireEvent.contextMenu(screen.getByRole("tab", { name: /^a/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Close tabs to the right" }));
    expect(titles()).toEqual(["a"]);
  });

  it("drags a tab to another position", () => {
    renderBar();
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? "",
      get types() {
        return [...data.keys()];
      },
      effectAllowed: "",
    };
    const c = screen.getByRole("tab", { name: /^c/ });
    const a = screen.getByRole("tab", { name: /^a/ });
    fireEvent.dragStart(c, { dataTransfer });
    // jsdom has no layout or drag coordinates: the pointer counts as on the hovered
    // tab's right half, so the tab lands after it.
    fireEvent.dragOver(a, { dataTransfer });
    fireEvent.drop(a, { dataTransfer });
    expect(titles()).toEqual(["a", "c", "b"]);
  });

  it("moves between tabs with the arrow keys, Home and End", async () => {
    const user = userEvent.setup();
    renderBar();
    const a = screen.getByRole("tab", { name: /^a/ });
    expect(a).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: /^b/ })).toHaveAttribute("tabindex", "-1");
    a.focus();
    await user.keyboard("{ArrowRight}");
    expect(useSessions.getState().activeId).toBe("b");
    expect(screen.getByRole("tab", { name: /^b/ })).toHaveFocus();
    expect(screen.getByRole("tab", { name: /^b/ })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(useSessions.getState().activeId).toBe("c");
    expect(screen.getByRole("tab", { name: /^c/ })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(useSessions.getState().activeId).toBe("a");
    await user.keyboard("{End}");
    expect(useSessions.getState().activeId).toBe("c");
    expect(screen.getByRole("tab", { name: /^c/ })).toHaveFocus();
  });

  it("keeps the active tab's close control visible, outside the tab's own tab stop", async () => {
    const user = userEvent.setup();
    renderBar();
    const closeA = screen.getByRole("button", { name: "Close a" });
    expect(closeA).toHaveClass("opacity-100");
    expect(closeA.tagName).not.toBe("BUTTON");
    expect(closeA).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: "Close b" })).toHaveClass("opacity-0");
    await user.click(closeA);
    expect(closeTab).toHaveBeenCalledWith("a");
  });

  it("closes on middle-click", () => {
    renderBar();
    act(() => {
      fireEvent(
        screen.getByRole("tab", { name: /^b/ }),
        new MouseEvent("auxclick", { bubbles: true, button: 1 }),
      );
    });
    expect(closeTab).toHaveBeenCalledWith("b");
  });
});
