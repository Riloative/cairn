import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import type { TransferVariant } from "@/lib/ipc";
import { useNotifications } from "@/stores/notifications";
import { useSerial } from "@/stores/serial";
import { useSessions } from "@/stores/sessions";
import { focusActiveTerminal } from "./controller";
import { formatBytes } from "@/lib/format";
import { cancelTransfer, runTransfer, VARIANT_LABEL } from "./serialControls";

const VARIANTS: readonly { value: TransferVariant; label: string }[] = [
  { value: "xmodem", label: VARIANT_LABEL.xmodem },
  { value: "xmodem1k", label: VARIANT_LABEL.xmodem1k },
  { value: "ymodem", label: VARIANT_LABEL.ymodem },
];

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** X/Ymodem send/receive for the serial tab in `useSerial().dialogTab`. */
export function TransferDialog() {
  const tabId = useSerial((s) => s.dialogTab);
  const direction = useSerial((s) => s.dialogDirection);
  const transfer = useSerial((s) => (tabId ? s.transfers[tabId] : undefined));
  const closeDialog = useSerial((s) => s.closeDialog);
  const title = useSessions((s) => s.tabs.find((t) => t.id === tabId)?.title);
  const notifyError = useNotifications((s) => s.notifyError);
  const [variant, setVariant] = useState<TransferVariant>("ymodem");
  // Choices belong to one tab and direction; switching either starts fresh.
  const key = `${tabId ?? ""}|${direction}`;
  const [picked, setPicked] = useState<{ key: string; targets: string[] }>({ key, targets: [] });
  const targets = picked.key === key ? picked.targets : [];
  const setTargets = (t: string[]) => setPicked({ key, targets: t });

  const running = transfer?.phase === "running";
  // Show the finished state only for the direction the user is looking at.
  const shown = transfer && transfer.direction === direction ? transfer : undefined;
  const sending = direction === "send";

  async function choose() {
    try {
      const picked = await openFileDialog(
        sending
          ? { multiple: variant === "ymodem", directory: false, title: "Files to send" }
          : { multiple: false, directory: true, title: "Save received files in" },
      );
      if (typeof picked === "string") setTargets([picked]);
      else if (Array.isArray(picked)) setTargets(picked);
    } catch (e) {
      notifyError(e, "Could not open the file picker");
    }
  }

  function start() {
    if (!tabId || targets.length === 0) return;
    useSerial.getState().setTransfer(tabId, null);
    void runTransfer(tabId, direction, variant, targets);
  }

  const pct =
    shown && shown.total ? Math.min(100, Math.round((shown.bytes / shown.total) * 100)) : null;
  const needsSingle = sending && variant !== "ymodem" && targets.length > 1;

  return (
    <Dialog open={tabId !== null} onOpenChange={(o) => !o && closeDialog()}>
      <DialogContent
        title={sending ? "Send file" : "Receive file"}
        description={
          sending
            ? `Upload over the serial line on ${title ?? "this tab"}. Start the receiver on the device first (rb, or xmodem in ROMMON).`
            : `Download over the serial line on ${title ?? "this tab"}. Start the sender on the device after clicking Receive.`
        }
        className="w-[min(520px,calc(100vw-32px))]"
        onClosed={focusActiveTerminal}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-fg-muted">Protocol</span>
            <SegmentedControl
              label="Protocol"
              value={variant}
              options={VARIANTS}
              onChange={(v) => setVariant(v)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-fg-muted">
              {sending ? "Files" : "Folder"}
            </span>
            <div className="flex items-center gap-2">
              <span
                className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface-raised/60 px-2 py-1.5 font-mono text-xs"
                title={targets.join("\n")}
              >
                {targets.length === 0
                  ? "Nothing chosen"
                  : sending
                    ? targets.map(basename).join(", ")
                    : targets[0]}
              </span>
              <Button type="button" disabled={running} onClick={() => void choose()}>
                Choose…
              </Button>
            </div>
            <p className={needsSingle ? "text-xs text-danger" : "text-xs text-fg-subtle"}>
              {needsSingle
                ? "Xmodem sends one file; choose Ymodem for several."
                : sending
                  ? "Ymodem sends names and sizes and supports several files."
                  : "Xmodem files are saved as xmodem-<time>.bin; existing files are never overwritten."}
            </p>
          </div>

          {shown && (
            <div className="flex flex-col gap-1.5" aria-live="polite">
              <div
                role="progressbar"
                aria-label="Transfer progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct ?? undefined}
                className="h-1.5 overflow-hidden rounded-full bg-surface-raised"
              >
                <div
                  className={
                    shown.phase === "failed"
                      ? "h-full bg-danger"
                      : shown.phase === "cancelled"
                        ? "h-full bg-fg-subtle"
                        : "h-full bg-accent transition-[width] duration-150"
                  }
                  style={{
                    width: `${shown.phase === "done" ? 100 : (pct ?? (running ? 5 : 100))}%`,
                  }}
                />
              </div>
              <p className="text-xs text-fg-muted">
                {shown.phase === "running" &&
                  `${formatBytes(shown.bytes)}${shown.total ? ` of ${formatBytes(shown.total)}` : ""} · ${VARIANT_LABEL[shown.variant]}`}
                {shown.phase === "done" &&
                  `Done: ${shown.files.map(basename).join(", ")} (${formatBytes(shown.bytes)})`}
                {shown.phase === "failed" && shown.message}
                {shown.phase === "cancelled" && "Cancelled."}
              </p>
            </div>
          )}

          <DialogFooter>
            {running ? (
              <>
                <Button type="button" variant="ghost" onClick={closeDialog}>
                  Hide
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  onClick={() => tabId && cancelTransfer(tabId)}
                >
                  Cancel transfer
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="ghost" onClick={closeDialog}>
                  Close
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  disabled={targets.length === 0 || needsSingle}
                  onClick={start}
                >
                  {sending ? "Send" : "Receive"}
                </Button>
              </>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
