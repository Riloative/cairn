import { useRef } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { profileById, useTerminalPrefs } from "@/stores/terminalPrefs";
import { useTerminalUi } from "@/stores/terminalUi";
import { focusActiveTerminal } from "./controller";
import { pasteLines } from "./paste";

const PREVIEW_LINES = 12;

/** Confirms multi-line pastes; shows the line count and the first lines as plain text. */
export function PasteConfirmDialog() {
  const pending = useTerminalUi((s) => s.pendingPaste);
  const resolve = useTerminalUi((s) => s.resolvePaste);
  const delay = useTerminalPrefs((s) => profileById(s.prefs).pasteLineDelayMs);
  const pasteRef = useRef<HTMLButtonElement>(null);
  if (!pending) return null;
  const lines = pasteLines(pending.text);

  return (
    <Dialog open onOpenChange={(o) => !o && resolve("cancel")}>
      <DialogContent
        title={`Paste ${lines.length} lines?`}
        description="Each line runs as a command on the device. Check it is what you meant to paste."
        initialFocus={pasteRef}
        onClosed={focusActiveTerminal}
        className="w-[min(640px,calc(100vw-32px))]"
      >
        <pre
          data-selectable
          className="max-h-64 overflow-auto rounded-lg bg-surface-raised p-3 font-mono text-xs whitespace-pre text-fg-muted"
        >
          {lines.slice(0, PREVIEW_LINES).join("\n")}
          {lines.length > PREVIEW_LINES && `\n… ${lines.length - PREVIEW_LINES} more lines`}
        </pre>
        <DialogFooter>
          <Button variant="ghost" onClick={() => resolve("cancel")}>
            Cancel
          </Button>
          <Button onClick={() => resolve("slow")}>
            Paste slowly ({Math.max(delay, 50)} ms/line)
          </Button>
          <Button ref={pasteRef} variant="primary" onClick={() => resolve("paste")}>
            Paste {lines.length} lines
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
