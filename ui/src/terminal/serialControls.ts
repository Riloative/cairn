import * as ipc from "@/lib/ipc";
import type { TransferStatus, TransferVariant } from "@/lib/ipc";
import { useNotifications } from "@/stores/notifications";
import { useSerial, type TransferDirection } from "@/stores/serial";
import { useSessions } from "@/stores/sessions";
import { backendSessionId } from "./controller";

/** Line controls, BREAK and X/Ymodem transfers for serial (and BREAK for Telnet) tabs. */

export const VARIANT_LABEL: Record<TransferVariant, string> = {
  xmodem: "Xmodem",
  xmodem1k: "Xmodem-1K",
  ymodem: "Ymodem",
};

function tabTitle(tabId: string): string {
  return useSessions.getState().tabs.find((t) => t.id === tabId)?.title ?? "session";
}

export function supportsBreak(protocol: string | undefined): boolean {
  return protocol === "serial" || protocol === "telnet";
}

export async function sendBreak(tabId: string) {
  const id = backendSessionId(tabId);
  if (!id) return;
  try {
    await ipc.sessionBreak(id);
  } catch (e) {
    useNotifications.getState().notifyError(e, "Could not send BREAK");
  }
}

export async function setLine(tabId: string, line: "dtr" | "rts", on: boolean) {
  const id = backendSessionId(tabId);
  if (!id) return;
  try {
    await ipc.serialSetLines(id, { [line]: on });
    useSerial.getState().setLines(tabId, { [line]: on });
  } catch (e) {
    useNotifications.getState().notifyError(e, `Could not set ${line.toUpperCase()}`);
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * Run a transfer on a serial tab. `targets` are the files to send, or a single folder to
 * receive into. State is tracked in the serial store so the dialog can close and reopen.
 */
export async function runTransfer(
  tabId: string,
  direction: TransferDirection,
  variant: TransferVariant,
  targets: string[],
) {
  const id = backendSessionId(tabId);
  const store = useSerial.getState();
  if (!id || store.transfers[tabId]?.phase === "running") return;
  const base = { direction, variant, files: [] as string[] };
  store.setTransfer(tabId, { ...base, phase: "running", bytes: 0, total: null });
  const onProgress = (s: TransferStatus) => {
    if (s.phase !== "running") return;
    const cur = useSerial.getState().transfers[tabId];
    if (cur?.phase === "running")
      useSerial.getState().setTransfer(tabId, { ...cur, bytes: s.bytes, total: s.total });
  };
  const notify = useNotifications.getState().notify;
  try {
    let files: string[];
    let bytes: number;
    if (direction === "send") {
      const done = await ipc.serialSendFiles(id, variant, targets, onProgress);
      files = done.phase === "done" ? done.files : [];
      bytes = done.phase === "done" ? done.bytes : 0;
    } else {
      files = await ipc.serialReceiveFiles(id, variant, targets[0] ?? "", onProgress);
      bytes = useSerial.getState().transfers[tabId]?.bytes ?? 0;
    }
    if (!useSerial.getState().transfers[tabId]) return; // tab closed meanwhile
    useSerial.getState().setTransfer(tabId, { ...base, phase: "done", bytes, total: bytes, files });
    notify({
      variant: "success",
      title: direction === "send" ? "File sent" : "File received",
      description: `${files.join(", ")} (${formatBytes(bytes)}) over ${VARIANT_LABEL[variant]} on ${tabTitle(tabId)}`,
    });
  } catch (e) {
    const err = ipc.CommandError.from(e);
    const cancelled = err.code === "serial.cancelled";
    const cur = useSerial.getState().transfers[tabId];
    if (!cur) return;
    useSerial.getState().setTransfer(tabId, {
      ...cur,
      phase: cancelled ? "cancelled" : "failed",
      message: err.message,
    });
    if (!cancelled) useNotifications.getState().notifyError(e, "File transfer failed");
  }
}

export function cancelTransfer(tabId: string) {
  const id = backendSessionId(tabId);
  if (id) ipc.serialTransferCancel(id).catch(() => {});
}
