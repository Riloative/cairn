import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { useBroadcast } from "@/stores/broadcast";
import { useSessions, type SessionTab } from "@/stores/sessions";
import { PROTOCOL_LABEL } from "@/app/protocol";
import { focusActiveTerminal } from "@/terminal/controller";

function Picker({ tabs }: { tabs: SessionTab[] }) {
  const close = () => useBroadcast.getState().setPickerOpen(false);
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(tabs.filter((t) => t.state === "connected").map((t) => t.id)),
  );
  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChosen(next);
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    if (chosen.size < 2) return;
    useBroadcast.getState().start([...chosen]);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent
        title="Broadcast input"
        description="What you type in any of these tabs is sent to all of them, until you stop broadcast."
        onClosed={focusActiveTerminal}
      >
        <form onSubmit={submit} className="flex flex-col gap-3">
          <fieldset className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            <legend className="sr-only">Sessions</legend>
            {tabs.map((t) => (
              <label
                key={t.id}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-surface-raised"
              >
                <input
                  type="checkbox"
                  className="accent-[var(--accent)]"
                  checked={chosen.has(t.id)}
                  onChange={() => toggle(t.id)}
                />
                <span className="flex-1 truncate">{t.title}</span>
                <span className="text-xs text-fg-subtle">
                  {PROTOCOL_LABEL[t.protocol]}
                  {t.state !== "connected" && ` · ${t.state}`}
                </span>
              </label>
            ))}
          </fieldset>
          {chosen.size < 2 && (
            <p role="alert" className="text-xs text-fg-muted">
              Choose at least two sessions.
            </p>
          )}
          <DialogFooter className="mt-2">
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={chosen.size < 2}>
              Start broadcast
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function BroadcastDialog() {
  const open = useBroadcast((s) => s.pickerOpen);
  const tabs = useSessions((s) => s.tabs).filter((t) => t.protocol !== "rdp");
  return open ? <Picker tabs={tabs} /> : null;
}
