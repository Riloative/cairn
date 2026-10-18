import { ShieldAlert, ShieldQuestion } from "lucide-react";
import { useRef, useState } from "react";
import { focusActiveTerminal } from "@/terminal/controller";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import type { PendingPrompt } from "@/stores/prompts";

type HostKeyPending = Extract<PendingPrompt, { type: "host_key" }>;

const ACCEPT_WORD = "accept";

function Fingerprint({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-fg-subtle">{label}</span>
      <code data-selectable className="font-mono text-[13px] break-all">
        {value}
      </code>
    </div>
  );
}

/** Trust-on-first-use dialog for an unknown host key. */
function UnknownHostKey({
  p,
  onAnswer,
}: {
  p: HostKeyPending;
  onAnswer: (accept: boolean) => void;
}) {
  const target = p.info.port === 22 ? p.info.host : `${p.info.host}:${p.info.port}`;
  const trustRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open onOpenChange={(open) => !open && onAnswer(false)}>
      <DialogContent
        initialFocus={trustRef}
        onClosed={focusActiveTerminal}
        title={`Trust ${target}?`}
        description="This is the first connection to this host. Compare the fingerprint with the device (e.g. `show crypto key mypubkey rsa`, `ssh-keygen -lf`) before trusting it."
      >
        <div className="flex gap-3 rounded-lg bg-surface-raised p-3">
          <ShieldQuestion size={18} className="mt-0.5 shrink-0 text-accent" />
          <div className="flex flex-col gap-2">
            <Fingerprint label={p.info.keyType} value={p.info.fingerprint} />
            {p.openssh === "mismatch" && (
              <p className="text-xs text-warning">
                Your ~/.ssh/known_hosts has a different key for this host.
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onAnswer(false)}>
            Cancel
          </Button>
          <Button ref={trustRef} variant="primary" onClick={() => onAnswer(true)}>
            Trust and connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Full-screen warning for a changed host key; proceeding requires typing "accept". */
export function ChangedHostKey({
  p,
  onAnswer,
}: {
  p: HostKeyPending;
  onAnswer: (accept: boolean) => void;
}) {
  const [typed, setTyped] = useState("");
  const previous = p.status.status === "changed" ? p.status.previousFingerprint : "";
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="hostkey-changed-title"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-bg/95 p-8 backdrop-blur-sm animate-fade-in"
    >
      <div className="w-full max-w-xl rounded-xl border-2 border-danger bg-surface p-8 shadow-lg">
        <div className="flex items-center gap-3 text-danger">
          <ShieldAlert size={28} />
          <h1 id="hostkey-changed-title" className="text-lg font-semibold">
            The host key for {p.info.host}:{p.info.port} has changed
          </h1>
        </div>
        <p className="mt-3 text-fg-muted">
          Someone could be intercepting this connection (man-in-the-middle), or the device was
          replaced, re-imaged or had its keys regenerated. Do not continue unless you know why the
          key changed.
        </p>
        <div className="mt-5 flex flex-col gap-3 rounded-lg bg-surface-raised p-4">
          <Fingerprint label={`Previously trusted (${p.info.keyType})`} value={previous} />
          <Fingerprint label="Now presented" value={p.info.fingerprint} />
        </div>
        <form
          className="mt-6 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim().toLowerCase() === ACCEPT_WORD) {
              onAnswer(true);
              focusActiveTerminal();
            }
          }}
        >
          <label className="text-[13px]" htmlFor="hostkey-accept">
            Type <strong>{ACCEPT_WORD}</strong> to replace the stored key and connect.
          </label>
          <Input
            id="hostkey-accept"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="primary"
              autoFocus
              onClick={() => {
                onAnswer(false);
                focusActiveTerminal();
              }}
            >
              Disconnect
            </Button>
            <Button
              type="submit"
              variant="danger"
              disabled={typed.trim().toLowerCase() !== ACCEPT_WORD}
            >
              Replace key and connect
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function HostKeyPrompt({
  p,
  onAnswer,
}: {
  p: HostKeyPending;
  onAnswer: (accept: boolean) => void;
}) {
  return p.status.status === "changed" ? (
    <ChangedHostKey p={p} onAnswer={onAnswer} />
  ) : (
    <UnknownHostKey p={p} onAnswer={onAnswer} />
  );
}
