import { useConfirm } from "@/stores/confirm";
import { Button } from "./Button";
import { Dialog, DialogContent, DialogFooter } from "./Dialog";

/** Renders the pending `confirmAction` request. Mounted once in the shell. */
export function ConfirmDialog() {
  const request = useConfirm((s) => s.request);
  const answer = useConfirm((s) => s.answer);
  return (
    <Dialog open={request !== null} onOpenChange={(o) => !o && answer(false)}>
      {request && (
        <DialogContent title={request.title} description={request.description} hideClose>
          <DialogFooter>
            <Button variant="ghost" onClick={() => answer(false)}>
              Cancel
            </Button>
            <Button
              autoFocus
              variant={request.destructive ? "danger" : "primary"}
              onClick={() => answer(true)}
            >
              {request.confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
