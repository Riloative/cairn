import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { useSessions } from "@/stores/sessions";
import { useSnippets } from "@/stores/snippets";
import { FakeBackend } from "@/test/fakeBackend";
import { writeToTab } from "@/terminal/controller";
import { SnippetBar } from "@/terminal/SnippetBar";
import { SnippetsManager } from "./SnippetsManager";
import { SnippetVariablesDialog } from "./SnippetVariablesDialog";

vi.mock("@/terminal/controller", () => ({
  writeToTab: vi.fn(() => Promise.resolve()),
  profileIdOf: vi.fn(() => undefined),
  focusActiveTerminal: vi.fn(),
}));

let backend: FakeBackend;
const decoder = new TextDecoder();
const typed = () =>
  vi.mocked(writeToTab).mock.calls.map(([tab, bytes]) => [tab, decoder.decode(bytes)]);

beforeEach(() => {
  backend = new FakeBackend("unlocked");
  vi.mocked(writeToTab).mockClear();
  useSnippets.setState({ list: null, managerOpen: false, pending: null, barVisible: true });
  useSessions.setState({
    tabs: [
      {
        id: "t1",
        title: "sw1",
        protocol: "ssh",
        state: "connected",
        device: { id: 1, vendor: "Cisco" },
      },
    ],
    activeId: "t1",
  });
});

afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 0));
  backend.dispose();
});

function renderAll() {
  const tab = useSessions.getState().tabs[0]!;
  return render(
    <TooltipProvider>
      <SnippetBar tab={tab} />
      <SnippetsManager />
      <SnippetVariablesDialog />
      <ConfirmDialog />
    </TooltipProvider>,
  );
}

describe("snippets", () => {
  it("creates a snippet with variables and types it with the values", async () => {
    const user = userEvent.setup();
    renderAll();
    act(() => useSnippets.getState().openManager());
    const form = await screen.findByRole("form", { name: "New snippet" });
    await user.type(within(form).getByLabelText("Name"), "Describe");
    await user.type(within(form).getByLabelText("Folder"), "Cisco");
    // userEvent treats { as a key descriptor; {{ types a literal brace.
    await user.type(
      within(form).getByLabelText("Commands"),
      "interface {{{{iface}}\n description {{{{text:uplink}}",
    );
    await user.click(within(form).getByRole("button", { name: "Add snippet" }));
    await waitFor(() => expect(backend.snippets).toHaveLength(1));
    expect(backend.snippets[0]).toMatchObject({ name: "Describe", folder: "Cisco" });
    expect(backend.snippets[0]?.variables.map((v) => v.name)).toEqual(["iface", "text"]);

    // From the snippet bar: asks for the variables, then types the result.
    act(() => useSnippets.getState().closeManager());
    await user.click(await screen.findByRole("button", { name: /Cisco\/Describe/ }));
    const dialog = await screen.findByRole("dialog", { name: "Cisco/Describe" });
    await user.type(within(dialog).getByLabelText("iface"), "Gi1/0/1");
    expect(within(dialog).getByLabelText("Preview")).toHaveTextContent(
      "interface Gi1/0/1 description uplink",
    );
    await user.click(within(dialog).getByRole("button", { name: "Insert" }));
    await waitFor(() =>
      expect(typed()).toEqual([
        ["t1", "interface Gi1/0/1\r"],
        ["t1", " description uplink"],
      ]),
    );
  });

  it("validates variables before saving and filters the bar by vendor", async () => {
    backend.snippets = [
      {
        id: 1,
        name: "Junos only",
        folder: "",
        vendor: "Juniper",
        body: "show route",
        description: "",
        variables: [],
      },
      {
        id: 2,
        name: "Uptime",
        folder: "",
        vendor: "",
        body: "show version",
        description: "",
        variables: [],
      },
    ];
    const user = userEvent.setup();
    renderAll();
    const bar = await screen.findByRole("toolbar", { name: "Snippets" });
    expect(await within(bar).findByRole("button", { name: "Uptime" })).toBeInTheDocument();
    expect(within(bar).queryByRole("button", { name: "Junos only" })).not.toBeInTheDocument();
    await user.click(within(bar).getByRole("button", { name: "Uptime" }));
    expect(typed()).toEqual([["t1", "show version"]]);

    act(() => useSnippets.getState().openManager(0));
    const form = await screen.findByRole("form", { name: "New snippet" });
    await user.type(within(form).getByLabelText("Name"), "Broken");
    await user.type(within(form).getByLabelText("Commands"), "show {{{{1x}}");
    await user.click(within(form).getByRole("button", { name: "Add snippet" }));
    expect(within(form).getByText(/is not a valid variable/)).toBeVisible();
    expect(backend.snippets).toHaveLength(2);
  });
});
