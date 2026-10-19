import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/Skeleton";
import { knownHostsList, knownHostsRemove, type KnownHost } from "@/lib/ipc";
import { useNotifications } from "@/stores/notifications";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** Cairn's trusted SSH host keys, with removal (the next connection asks again). */
export function KnownHosts() {
  const [hosts, setHosts] = useState<KnownHost[] | null>(null);
  const notifyError = useNotifications((s) => s.notifyError);

  const reload = useCallback(
    () =>
      knownHostsList()
        .then(setHosts)
        .catch((e: unknown) => notifyError(e, "Could not load known hosts")),
    [notifyError],
  );

  useEffect(() => {
    let alive = true;
    knownHostsList()
      .then((h) => alive && setHosts(h))
      .catch((e: unknown) => notifyError(e, "Could not load known hosts"));
    return () => {
      alive = false;
    };
  }, [notifyError]);

  if (hosts === null) return <Skeleton className="h-16" />;
  if (hosts.length === 0)
    return <p className="py-2 text-xs text-fg-subtle">No trusted host keys or certificates yet.</p>;
  return (
    <ul className="flex flex-col">
      {hosts.map((h) => (
        <li
          key={`${h.host}:${h.port}:${h.keyType}`}
          className="group flex items-center gap-3 border-b border-border py-2 last:border-0"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate">
              {h.host}
              {h.port !== 22 && <span className="text-fg-subtle">:{h.port}</span>}
            </p>
            <p className="truncate font-mono text-xs text-fg-muted" data-selectable>
              {h.keyType === "x509" ? "RDP certificate" : h.keyType} {h.fingerprint}
            </p>
          </div>
          <span className="text-xs text-fg-subtle">
            last seen {dateFormat.format(new Date(h.lastSeen))}
          </span>
          <button
            type="button"
            aria-label={`Forget ${h.host} ${h.keyType}`}
            onClick={() =>
              void knownHostsRemove(h.host, h.port, h.keyType)
                .then(reload)
                .catch((e: unknown) => notifyError(e, "Could not remove the key"))
            }
            className="rounded-md p-1 text-fg-subtle opacity-0 group-hover:opacity-100 hover:bg-surface-raised hover:text-danger focus-visible:opacity-100"
          >
            <Trash2 size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
}
