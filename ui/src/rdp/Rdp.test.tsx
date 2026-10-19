import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import type { CertInfo, RdpMessage } from "@/lib/ipc";
import { SessionPrompts } from "@/ssh/SessionPrompts";
import { QuickConnectDialog } from "@/ssh/QuickConnectDialog";
import { usePrompts } from "@/stores/prompts";
import { useRdp } from "@/stores/rdp";
import { useSessions } from "@/stores/sessions";
import { useUi } from "@/stores/ui";
import { FakeBackend } from "@/test/fakeBackend";
import { closeTab } from "@/terminal/controller";
import { connect } from "@/views/inventory/deviceActions";
import { NEW_DEVICE } from "@/views/inventory/model";
import { methodError } from "@/views/inventory/model";
import { SessionsView } from "@/views/SessionsView";
import { keyInput, toDesktop, wheelUnits } from "./keyboard";

let backend: FakeBackend;

beforeEach(() => {
  backend = new FakeBackend("unlocked");
});

afterEach(async () => {
  for (const t of useSessions.getState().tabs) closeTab(t.id);
  cleanup();
  await new Promise((r) => setTimeout(r, 0));
  backend.dispose();
  usePrompts.setState({ queue: [] });
  useUi.setState({ quickConnectOpen: false, connectProtocol: "ssh" });
});

const cert: CertInfo = {
  host: "10.0.0.20",
  port: 3389,
  fingerprint: "AB:CD:EF",
  digest: "abcdef",
  subject: "CN=srv1",
  issuer: "CN=srv1",
  notBefore: 1_700_000_000,
  notAfter: 1_900_000_000,
  selfSigned: true,
  expired: false,
};

function push(msg: RdpMessage, index = 0) {
  act(() => backend.rdpSessions[index]!.onEvent.onmessage(msg));
}

/** A frame message: desktop size and one rectangle. */
function frame(width: number, height: number): ArrayBuffer {
  const le = (...v: number[]) => v.flatMap((n) => [n & 0xff, n >> 8]);
  const bytes = Uint8Array.from([0, ...le(width, height, 1), ...le(0, 0, 1, 1), 9, 9, 9, 255]);
  return bytes.buffer;
}

function renderApp() {
  return render(
    <TooltipProvider>
      <SessionsView />
      <QuickConnectDialog />
      <SessionPrompts />
    </TooltipProvider>,
  );
}

describe("RDP session tab", () => {
  it("connects from quick connect, pins the certificate, streams frames and takes input", async () => {
    const user = userEvent.setup();
    renderApp();
    act(() => useUi.getState().openConnect("rdp"));
    await user.type(await screen.findByLabelText("Destination"), "10.0.0.20");
    await user.type(screen.getByLabelText("Username"), "CORP\\admin");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(backend.rdpSessions).toHaveLength(1));
    expect(backend.rdpSessions[0]!.args.options).toMatchObject({
      host: "10.0.0.20",
      port: 3389,
      username: "CORP\\admin",
      password: null,
      security: "nla",
      width: 0,
      clipboard: true,
    });
    const tab = useSessions.getState().tabs[0]!;
    expect(tab).toMatchObject({ protocol: "rdp", title: "10.0.0.20", state: "connecting" });

    // Certificate: shown with its fingerprint; trusting answers the prompt.
    push({ type: "certificate", promptId: 7, cert, status: { status: "unknown" } });
    expect(await screen.findByText("Trust the certificate of 10.0.0.20?")).toBeVisible();
    expect(screen.getByText("AB:CD:EF")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Trust and connect" }));
    await waitFor(() =>
      expect(backend.promptReplies).toEqual([
        { promptId: 7, answer: { kind: "hostKey", accept: true } },
      ]),
    );

    // Password prompt reuses the credential dialog.
    push({ type: "credentials", promptId: 8, username: "admin", target: "10.0.0.20:3389" });
    expect(
      await screen.findByRole("dialog", { name: "Password for admin@10.0.0.20:3389" }),
    ).toBeVisible();
    await user.type(screen.getByLabelText("Password"), "s3cret{Enter}");
    await waitFor(() => expect(backend.promptReplies).toHaveLength(2));

    push({ type: "event", event: { type: "connected", width: 1024, height: 768 } });
    expect(useSessions.getState().tabs[0]!.state).toBe("connected");
    expect(await screen.findByText("1024×768")).toBeVisible();

    // A frame sizes the canvas to the desktop.
    act(() => backend.rdpSessions[0]!.onFrame.onmessage(frame(1024, 768)));
    const canvas = screen.getByLabelText("Remote desktop 10.0.0.20") as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([1024, 768]);

    // Keys go to the server as physical codes; mouse moves coalesce.
    canvas.focus();
    fireEvent.keyDown(canvas, { code: "KeyA", key: "a" });
    fireEvent.mouseMove(canvas, { clientX: 1, clientY: 1 });
    fireEvent.mouseMove(canvas, { clientX: 2, clientY: 2 });
    await waitFor(() => expect(backend.rdpInputs.length).toBeGreaterThan(0));
    const sent = backend.rdpInputs.flatMap((i) => i.events);
    expect(sent).toContainEqual({ kind: "key", code: "KeyA", down: true });
    expect(sent.filter((e) => e.kind === "move")).toHaveLength(1);

    // The server's clipboard lands locally; the session ends with a reconnect offer.
    push({
      type: "event",
      event: { type: "closed", graceful: true, message: "Server initiated disconnect." },
    });
    expect(await screen.findByText("Session ended")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(backend.rdpSessions).toHaveLength(2));
    // The reconnect asks for the password again instead of keeping it in the frontend.
    expect(backend.rdpSessions[1]!.args.options).toMatchObject({ password: null });

    closeTab(tab.id);
    expect(backend.rdpClosed).toContain("r2");
    expect(useRdp.getState().byTab[tab.id]).toBeUndefined();
  });

  it("warns about a changed certificate like a changed host key", async () => {
    renderApp();
    act(() => useUi.getState().openConnect("rdp"));
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Destination"), "admin@srv1:3390");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(backend.rdpSessions).toHaveLength(1));
    expect(backend.rdpSessions[0]!.args.options).toMatchObject({
      host: "srv1",
      port: 3390,
      username: "admin",
    });
    push({
      type: "certificate",
      promptId: 3,
      cert: { ...cert, host: "srv1", port: 3390 },
      status: { status: "changed", previousFingerprint: "11:22:33" },
    });
    expect(await screen.findByText("The host key for srv1:3390 has changed")).toBeVisible();
    expect(screen.getByText("11:22:33")).toBeVisible();
    expect(screen.getByRole("button", { name: "Replace key and connect" })).toBeDisabled();
  });

  it("opens devices in a tab, or in the external client when set", async () => {
    const rdp = {
      kind: "rdp" as const,
      port: 3389,
      username: "",
      domain: "",
      security: "nla" as const,
      width: 1280,
      height: 720,
      colorDepth: 32 as const,
      clipboard: false,
      tunnel: "",
      external: false,
    };
    const device = { ...NEW_DEVICE, id: 4, hostname: "win1", connections: [rdp] };
    connect(device, 0);
    await waitFor(() => expect(backend.rdpSessions).toHaveLength(1));
    expect(backend.calls.some((c) => c.cmd === "device_rdp_open")).toBe(true);
    const tabId = useSessions.getState().tabs[0]!.id;
    // A fixed resolution does not follow the view; clipboard follows the setting.
    expect(useRdp.getState().byTab[tabId]).toMatchObject({ followView: false, clipboard: false });

    connect({ ...device, connections: [{ ...rdp, external: true }] }, 0);
    await waitFor(() => expect(backend.rdpExternal).toEqual([{ deviceId: 4, method: 0 }]));
    expect(useSessions.getState().tabs).toHaveLength(1);
  });
});

describe("RDP input helpers and settings", () => {
  it("maps ⌘ to Ctrl on macOS when enabled", () => {
    const meta = new KeyboardEvent("keydown", { code: "MetaLeft" });
    expect(keyInput(meta, { mac: true, cmdAsCtrl: true })).toEqual({
      kind: "key",
      code: "ControlLeft",
      down: true,
    });
    expect(keyInput(meta, { mac: true, cmdAsCtrl: false })?.kind === "key").toBe(true);
    expect(
      keyInput(new KeyboardEvent("keyup", { code: "" }), { mac: false, cmdAsCtrl: true }),
    ).toBe(null);
  });

  it("scales pointer positions and wheel deltas", () => {
    const rect = { left: 10, top: 20, width: 512, height: 384 };
    expect(toDesktop(266, 212, rect, { width: 1024, height: 768 })).toEqual({ x: 512, y: 384 });
    expect(toDesktop(-50, 5000, rect, { width: 1024, height: 768 })).toEqual({ x: 0, y: 767 });
    expect(wheelUnits(100, 0)).toBe(-120);
    expect(wheelUnits(-3, 1)).toBe(120);
    expect(wheelUnits(10_000, 0)).toBe(-255);
  });

  it("validates RDP connection settings", () => {
    const base = {
      kind: "rdp" as const,
      port: 3389,
      username: "",
      domain: "",
      security: "nla" as const,
      width: 0,
      height: 0,
      colorDepth: 32 as const,
      clipboard: true,
      tunnel: "",
      external: false,
    };
    expect(methodError(base)).toBeUndefined();
    expect(methodError({ ...base, width: 1920 })).toMatch(/resolution/);
    expect(methodError({ ...base, tunnel: "ops @bastion" })).toMatch(/tunnel/);
  });
});
