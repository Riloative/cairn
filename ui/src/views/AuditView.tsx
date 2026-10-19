import { save } from "@tauri-apps/plugin-dialog";
import {
  ChevronRight,
  Download,
  ListFilter,
  Search,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/Menu";
import { NativeSelect } from "@/components/ui/NativeSelect";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import * as ipc from "@/lib/ipc";
import type { AuditEntry, AuditFacets, IntegrityReport } from "@/lib/ipc";
import { activeFilterCount, toAuditFilter, useAuditView, type TimeRange } from "@/stores/auditView";
import { useNotifications } from "@/stores/notifications";
import { dateFormat, LABELS, summarize } from "./auditFormat";

const PAGE = 200;
const SEARCH_DEBOUNCE_MS = 250;

const RANGES: readonly { value: TimeRange; label: string }[] = [
  { value: "any", label: "Any time" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "custom", label: "Custom range" },
];

const label = (kind: string) => LABELS[kind] ?? kind;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Event-type checklist in a popover. */
function KindFilter({ kinds, selected }: { kinds: string[]; selected: string[] }) {
  const set = useAuditView((s) => s.set);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className={cn(selected.length > 0 && "bg-accent-subtle text-fg")}
        >
          <ListFilter size={13} />
          {selected.length === 0
            ? "All events"
            : selected.length === 1
              ? label(selected[0] ?? "")
              : `${selected.length} event types`}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="max-h-80 w-64 overflow-y-auto">
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-xs font-medium text-fg-muted">Event type</legend>
          {[...kinds]
            .sort((a, b) => label(a).localeCompare(label(b)))
            .map((k) => (
              <label key={k} className="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  className="accent-[var(--accent)]"
                  checked={selected.includes(k)}
                  onChange={(e) =>
                    set({
                      kinds: e.target.checked ? [...selected, k] : selected.filter((x) => x !== k),
                    })
                  }
                />
                {label(k)}
              </label>
            ))}
        </fieldset>
      </PopoverContent>
    </Popover>
  );
}

/** The entry's payload as label/value pairs, plus its chain hashes. */
function EntryDetails({ entry }: { entry: AuditEntry }) {
  const rows = Object.entries(entry.payload).filter(([k]) => k !== "kind");
  const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  return (
    <dl
      data-selectable
      className="grid grid-cols-[160px_1fr] gap-x-4 gap-y-1 rounded-lg bg-surface-raised px-4 py-3 text-xs"
    >
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="text-fg-subtle">{k}</dt>
          <dd className="font-mono break-all">{v === null ? "—" : show(v)}</dd>
        </Fragment>
      ))}
      <dt className="text-fg-subtle">hash</dt>
      <dd className="font-mono break-all text-fg-muted">{entry.hash}</dd>
      <dt className="text-fg-subtle">previous hash</dt>
      <dd className="font-mono break-all text-fg-muted">{entry.prevHash}</dd>
    </dl>
  );
}

export function AuditView() {
  const filter = useAuditView((s) => s.filter);
  const setFilter = useAuditView((s) => s.set);
  const reset = useAuditView((s) => s.reset);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<AuditFacets>({ kinds: [], devices: [], protocols: [] });
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [search, setSearch] = useState(filter.text);
  const text = useDebounced(search, SEARCH_DEBOUNCE_MS);
  const notifyError = useNotifications((s) => s.notifyError);
  const notify = useNotifications((s) => s.notify);

  useEffect(() => setFilter({ text }), [text, setFilter]);

  // Bumped to reload after verifying or exporting (both add an entry).
  const [version, setVersion] = useState(0);
  const load = () => setVersion((v) => v + 1);

  useEffect(() => {
    let alive = true;
    Promise.all([ipc.auditQuery(toAuditFilter(filter), null, PAGE), ipc.auditFacets()])
      .then(([page, f]) => {
        if (!alive) return;
        setEntries(page.entries);
        setTotal(page.total);
        setFacets(f);
      })
      .catch((e: unknown) => notifyError(e, "Could not load the audit log"));
    return () => {
      alive = false;
    };
  }, [filter, version, notifyError]);

  async function more() {
    const last = entries?.[entries.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const page = await ipc.auditQuery(toAuditFilter(filter), last.seq, PAGE);
      setEntries([...(entries ?? []), ...page.entries]);
      setTotal(page.total);
    } catch (e) {
      notifyError(e, "Could not load more entries");
    } finally {
      setLoadingMore(false);
    }
  }

  async function verify() {
    setVerifying(true);
    try {
      const r = await ipc.auditVerify();
      setReport(r);
      const pruned = r.prunedBefore
        ? ` Entries before #${r.prunedBefore} were removed by retention.`
        : "";
      notify(
        r.ok
          ? {
              title: "Audit log intact",
              description: `${r.entries} entries verified.${pruned}`,
              variant: "success",
            }
          : {
              title: "Audit log tampering detected",
              description: `The hash chain breaks at entry #${r.firstBadSeq}.`,
              variant: "error",
            },
      );
      load();
    } catch (e) {
      notifyError(e, "Integrity check failed");
    } finally {
      setVerifying(false);
    }
  }

  async function exportAs(format: "csv" | "json") {
    const stamp = new Date().toISOString().slice(0, 10);
    const path = await save({
      title: "Export audit log",
      defaultPath: `cairn-audit-${stamp}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (!path) return;
    try {
      const n = await ipc.auditExport(toAuditFilter(filter), format, path);
      notify({ variant: "success", title: `Exported ${n} entries`, description: path });
      load();
    } catch (e) {
      notifyError(e, "Could not export the audit log");
    }
  }

  const filters = activeFilterCount(filter);
  const clear = () => {
    reset();
    setSearch("");
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 px-6 pt-5 pb-3">
        <h1 className="flex-1 text-[15px] font-semibold tracking-tight">Audit log</h1>
        {report && (
          <span
            className={cn(
              "flex items-center gap-1.5 text-xs",
              report.ok ? "text-success" : "text-danger",
            )}
          >
            {report.ok ? <ShieldCheck size={14} /> : <ShieldAlert size={14} />}
            {report.ok ? "Chain intact" : `Broken at #${report.firstBadSeq}`}
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button disabled={!entries || total === 0}>
              <Download size={14} /> Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void exportAs("csv")}>
              CSV (spreadsheet)
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void exportAs("json")}>
              JSON (with hashes)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button onClick={() => void verify()} disabled={verifying}>
          {verifying ? "Verifying…" : "Verify integrity"}
        </Button>
      </header>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 pb-2">
        <div className="relative w-56">
          <Search
            size={13}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-subtle"
          />
          <Input
            aria-label="Search the audit log"
            placeholder="Search details"
            className="h-7 pl-7"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <NativeSelect
          aria-label="Time range"
          className="h-7"
          value={filter.range}
          onChange={(e) => setFilter({ range: e.target.value as TimeRange })}
        >
          {RANGES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </NativeSelect>
        {filter.range === "custom" && (
          <>
            <Input
              type="date"
              aria-label="From"
              className="h-7 w-36"
              value={filter.customFrom}
              onChange={(e) => setFilter({ customFrom: e.target.value })}
            />
            <span className="text-xs text-fg-subtle">to</span>
            <Input
              type="date"
              aria-label="To"
              className="h-7 w-36"
              value={filter.customTo}
              onChange={(e) => setFilter({ customTo: e.target.value })}
            />
          </>
        )}
        <KindFilter kinds={facets.kinds} selected={filter.kinds} />
        <NativeSelect
          aria-label="Device"
          className="h-7 max-w-44"
          value={filter.device}
          onChange={(e) => setFilter({ device: e.target.value })}
        >
          <option value="">All devices</option>
          {facets.devices.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Protocol"
          className="h-7"
          value={filter.protocol}
          onChange={(e) => setFilter({ protocol: e.target.value })}
        >
          <option value="">All protocols</option>
          {facets.protocols.map((p) => (
            <option key={p} value={p}>
              {p.toUpperCase()}
            </option>
          ))}
        </NativeSelect>
        {filters > 0 && (
          <Button size="sm" variant="ghost" onClick={clear}>
            <X size={13} /> Clear
          </Button>
        )}
        <span className="flex-1" />
        {entries && (
          <span className="text-xs text-fg-subtle" role="status">
            {filters > 0 ? `${total} matching` : `${total} entries`}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {entries === null ? (
          <div className="flex flex-col gap-2 p-2">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={<ListFilter size={20} />}
            title="No matching entries"
            description="Nothing in the audit log matches these filters."
            action={{ label: "Clear filters", onClick: clear }}
          />
        ) : (
          <table className="w-full border-separate border-spacing-0 text-[13px]">
            <thead className="sticky top-0 bg-surface text-left text-xs text-fg-subtle">
              <tr>
                <th className="w-6" aria-hidden />
                <th className="w-16 px-2 py-2 font-medium">#</th>
                <th className="w-56 px-2 py-2 font-medium">Time</th>
                <th className="w-56 px-2 py-2 font-medium">Event</th>
                <th className="px-2 py-2 font-medium">Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const expanded = open === e.seq;
                return (
                  <Fragment key={e.seq}>
                    <tr
                      className="cursor-default hover:bg-surface-raised"
                      onClick={() => setOpen(expanded ? null : e.seq)}
                    >
                      <td className="pl-1">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-label={`Details of entry ${e.seq}`}
                          className="flex rounded p-0.5 text-fg-subtle hover:text-fg"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            setOpen(expanded ? null : e.seq);
                          }}
                        >
                          <ChevronRight
                            size={13}
                            className={cn(
                              "transition-transform duration-150",
                              expanded && "rotate-90",
                            )}
                          />
                        </button>
                      </td>
                      <td className="px-2 py-1.5 font-mono text-xs text-fg-subtle">{e.seq}</td>
                      <td className="px-2 py-1.5 text-fg-muted">
                        {dateFormat.format(new Date(e.ts))}
                      </td>
                      <td className="px-2 py-1.5">{label(e.kind)}</td>
                      <td className="max-w-0 truncate px-2 py-1.5 text-fg-muted">{summarize(e)}</td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td />
                        <td colSpan={4} className="px-2 pt-1 pb-3">
                          <EntryDetails entry={e} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        {entries && entries.length < total && (
          <div className="flex justify-center py-3">
            <Button size="sm" variant="ghost" disabled={loadingMore} onClick={() => void more()}>
              {loadingMore ? "Loading…" : `Show more (${total - entries.length} older)`}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
