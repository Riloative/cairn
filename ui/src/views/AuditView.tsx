import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { auditRecent, auditVerify, type AuditEntry, type IntegrityReport } from "@/lib/ipc";
import { useNotifications } from "@/stores/notifications";
import { dateFormat, LABELS, summarize } from "./auditFormat";

export function AuditView() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [verifying, setVerifying] = useState(false);
  const notifyError = useNotifications((s) => s.notifyError);
  const notify = useNotifications((s) => s.notify);

  const load = useCallback(
    () =>
      auditRecent(500)
        .then(setEntries)
        .catch((e: unknown) => notifyError(e, "Could not load the audit log")),
    [notifyError],
  );

  useEffect(() => {
    let alive = true;
    auditRecent(500)
      .then((e) => alive && setEntries(e))
      .catch((e: unknown) => notifyError(e, "Could not load the audit log"));
    return () => {
      alive = false;
    };
  }, [notifyError]);

  async function verify() {
    setVerifying(true);
    try {
      const r = await auditVerify();
      setReport(r);
      notify(
        r.ok
          ? {
              title: "Audit log intact",
              description: `${r.entries} entries verified.`,
              variant: "success",
            }
          : {
              title: "Audit log tampering detected",
              description: `The hash chain breaks at entry #${r.firstBadSeq}.`,
              variant: "error",
            },
      );
      await load();
    } catch (e) {
      notifyError(e, "Integrity check failed");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 px-6 pt-5 pb-3">
        <h1 className="flex-1 text-[15px] font-semibold tracking-tight">Audit log</h1>
        {report && (
          <span
            className={
              report.ok
                ? "flex items-center gap-1.5 text-xs text-success"
                : "flex items-center gap-1.5 text-xs text-danger"
            }
          >
            {report.ok ? <ShieldCheck size={14} /> : <ShieldAlert size={14} />}
            {report.ok ? "Chain intact" : `Broken at #${report.firstBadSeq}`}
          </span>
        )}
        <Button onClick={() => void verify()} disabled={verifying}>
          {verifying ? "Verifying…" : "Verify integrity"}
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {entries === null ? (
          <div className="flex flex-col gap-2 p-2">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-[13px]">
            <thead className="sticky top-0 bg-surface text-left text-xs text-fg-subtle">
              <tr>
                <th className="w-16 px-2 py-2 font-medium">#</th>
                <th className="w-56 px-2 py-2 font-medium">Time</th>
                <th className="w-56 px-2 py-2 font-medium">Event</th>
                <th className="px-2 py-2 font-medium">Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.seq} className="hover:bg-surface-raised">
                  <td className="px-2 py-1.5 font-mono text-xs text-fg-subtle">{e.seq}</td>
                  <td className="px-2 py-1.5 text-fg-muted">{dateFormat.format(new Date(e.ts))}</td>
                  <td className="px-2 py-1.5">{LABELS[e.kind] ?? e.kind}</td>
                  <td className="truncate px-2 py-1.5 text-fg-muted">{summarize(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
