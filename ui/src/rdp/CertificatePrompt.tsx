import { ShieldQuestion } from "lucide-react";
import { useRef } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import type { PendingPrompt } from "@/stores/prompts";
import { ChangedHostKey } from "@/ssh/HostKeyPrompt";
import { focusActiveTerminal } from "@/terminal/controller";

type CertificatePending = Extract<PendingPrompt, { type: "certificate" }>;

const date = (secs: number) =>
  new Date(secs * 1000).toLocaleDateString(undefined, { dateStyle: "medium" });

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-fg-subtle">{label}</span>
      <span data-selectable className={mono ? "font-mono text-[13px] break-all" : "text-[13px]"}>
        {value}
      </span>
    </div>
  );
}

/**
 * Trust decision for an RDP server's TLS certificate. Unknown certificates are offered
 * for trust on first use; a changed one gets the full warning used for SSH host keys.
 */
export function CertificatePrompt({
  p,
  onAnswer,
}: {
  p: CertificatePending;
  onAnswer: (accept: boolean) => void;
}) {
  const trustRef = useRef<HTMLButtonElement>(null);
  const { cert } = p;
  if (p.status.status === "changed") {
    return (
      <ChangedHostKey
        p={{
          id: p.id,
          tabId: p.tabId,
          type: "host_key",
          info: {
            host: cert.host,
            port: cert.port,
            keyType: "TLS certificate (SHA-256)",
            fingerprint: cert.fingerprint,
            publicKey: cert.digest,
          },
          status: p.status,
          openssh: "unknown",
        }}
        onAnswer={onAnswer}
      />
    );
  }
  const target = cert.port === 3389 ? cert.host : `${cert.host}:${cert.port}`;
  return (
    <Dialog open onOpenChange={(open) => !open && onAnswer(false)}>
      <DialogContent
        initialFocus={trustRef}
        onClosed={focusActiveTerminal}
        title={`Trust the certificate of ${target}?`}
        description="This is the first RDP connection to this server. Compare the fingerprint with the server's certificate before trusting it; no credentials are sent until you do."
      >
        <div className="flex gap-3 rounded-lg bg-surface-raised p-3">
          <ShieldQuestion size={18} className="mt-0.5 shrink-0 text-accent-text" />
          <div className="flex min-w-0 flex-col gap-2">
            <Row label="Fingerprint (SHA-256)" value={cert.fingerprint} mono />
            <Row label="Subject" value={cert.subject || "—"} />
            {!cert.selfSigned && <Row label="Issuer" value={cert.issuer || "—"} />}
            <Row label="Valid" value={`${date(cert.notBefore)} – ${date(cert.notAfter)}`} />
            {cert.selfSigned && (
              <p className="text-xs text-fg-muted">
                Self-signed, as usual for RDP servers. Cairn remembers it and warns if it changes.
              </p>
            )}
            {cert.expired && (
              <p className="text-xs text-warning">This certificate is expired or not yet valid.</p>
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
