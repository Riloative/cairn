import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowUp,
  Download,
  File,
  FileSymlink,
  Folder,
  FolderPlus,
  KeyRound,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/Menu";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Skeleton } from "@/components/ui/Skeleton";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import * as ipc from "@/lib/ipc";
import type { RemoteEntry } from "@/lib/ipc";
import { confirmAction } from "@/stores/confirm";
import { useFiles, type TransferItem } from "@/stores/files";
import { baseName, formatMode, joinRemote, parentRemote } from "@/lib/remotePath";
import { useNotifications } from "@/stores/notifications";
import type { SessionTab } from "@/stores/sessions";

const ICON = { dir: Folder, file: File, link: FileSymlink, other: File } as const;

type Prompt =
  | { kind: "mkdir" }
  | { kind: "rename"; entry: RemoteEntry }
  | { kind: "chmod"; entry: RemoteEntry };

function PromptDialog({
  prompt,
  onDone,
}: {
  prompt: Prompt;
  onDone: (value: string | null) => void;
}) {
  const initial =
    prompt.kind === "rename"
      ? prompt.entry.name
      : prompt.kind === "chmod"
        ? formatMode(prompt.entry.mode)
        : "";
  const [value, setValue] = useState(initial);
  const error =
    prompt.kind === "chmod"
      ? /^[0-7]{3,4}$/.test(value)
        ? undefined
        : "Use octal permissions like 644 or 755."
      : !value.trim() || value.includes("/")
        ? "Enter a name without '/'."
        : undefined;
  const title =
    prompt.kind === "mkdir"
      ? "New folder"
      : prompt.kind === "rename"
        ? `Rename ${prompt.entry.name}`
        : `Permissions of ${prompt.entry.name}`;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!error) onDone(value.trim());
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onDone(null)}>
      <DialogContent title={title}>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field
            label={prompt.kind === "chmod" ? "Permissions (octal)" : "Name"}
            error={value ? error : undefined}
          >
            <Input
              autoFocus
              spellCheck={false}
              className={prompt.kind === "chmod" ? "font-mono" : undefined}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </Field>
          <DialogFooter className="mt-0">
            <Button type="button" variant="ghost" onClick={() => onDone(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!!error}>
              {prompt.kind === "mkdir" ? "Create" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Queue({ items }: { items: TransferItem[] }) {
  if (items.length === 0) return null;
  const finished = items.some((t) => t.state !== "queued" && t.state !== "running");
  return (
    <section aria-label="Transfers" className="border-t border-border p-2">
      <div className="mb-1 flex items-center text-xs font-medium text-fg-muted">
        <span className="flex-1">Transfers</span>
        {finished && (
          <button
            type="button"
            className="hover:text-fg"
            onClick={() => useFiles.getState().clearFinished()}
          >
            Clear
          </button>
        )}
      </div>
      <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
        {items.map((t) => {
          const pct = t.size ? Math.min(100, Math.round((t.bytes / t.size) * 100)) : null;
          return (
            <li key={t.id} className="text-xs">
              <div className="flex items-center gap-1.5">
                {t.direction === "upload" ? (
                  <Upload size={11} aria-label="Upload" className="shrink-0 text-fg-subtle" />
                ) : (
                  <Download size={11} aria-label="Download" className="shrink-0 text-fg-subtle" />
                )}
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                <span
                  className={cn(
                    "shrink-0 font-mono text-[10px]",
                    t.state === "failed"
                      ? "text-danger"
                      : t.state === "done"
                        ? "text-success"
                        : "text-fg-muted",
                  )}
                >
                  {t.state === "running"
                    ? pct !== null
                      ? `${pct}%`
                      : formatBytes(t.bytes)
                    : t.state}
                </span>
                {(t.state === "queued" || t.state === "running") && (
                  <button
                    type="button"
                    aria-label={`Cancel ${t.name}`}
                    className="text-fg-subtle hover:text-fg"
                    onClick={() => useFiles.getState().cancel(t.id)}
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
              {t.state === "running" && (
                <div className="mt-0.5 h-0.5 overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full bg-accent transition-[width] duration-150"
                    style={{ width: `${pct ?? 30}%` }}
                  />
                </div>
              )}
              {t.error && <p className="text-[11px] text-danger">{t.error}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** SCP mode: devices without SFTP; transfers by explicit remote path. */
function ScpForm({ tab, sessionId }: { tab: SessionTab; sessionId: string }) {
  const [remote, setRemote] = useState("");

  async function download() {
    const local = await save({ title: "Save as", defaultPath: baseName(remote) });
    if (!local) return;
    useFiles.getState().enqueue([
      {
        tabId: tab.id,
        sessionId,
        protocol: "scp",
        direction: "download",
        localPath: local,
        remotePath: remote,
        name: baseName(remote),
        size: null,
      },
    ]);
  }

  async function upload() {
    const picked = await open({ multiple: false, title: "File to upload" });
    if (typeof picked !== "string") return;
    // A folder or device file system ("flash:") gets the file's own name.
    const target =
      remote.endsWith("/") || remote.endsWith(":") ? joinRemote(remote, baseName(picked)) : remote;
    useFiles.getState().enqueue([
      {
        tabId: tab.id,
        sessionId,
        protocol: "scp",
        direction: "upload",
        localPath: picked,
        remotePath: target,
        name: baseName(picked),
        size: null,
      },
    ]);
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      <p className="text-xs text-fg-muted">
        For devices with an SCP server but no SFTP (Cisco:{" "}
        <code className="font-mono">ip scp server enable</code>).
      </p>
      <Field label="Remote path" description="e.g. flash:c2960.bin, nvram:startup-config, /tmp/">
        <Input
          spellCheck={false}
          className="font-mono"
          value={remote}
          onChange={(e) => setRemote(e.target.value)}
        />
      </Field>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={!remote || remote.endsWith("/") || remote.endsWith(":")}
          onClick={() => void download()}
        >
          <Download size={13} /> Download…
        </Button>
        <Button size="sm" variant="secondary" disabled={!remote} onClick={() => void upload()}>
          <Upload size={13} /> Upload…
        </Button>
      </div>
    </div>
  );
}

/** MobaXterm-style file panel next to an SSH terminal. */
export function FilePanel({ tab, sessionId }: { tab: SessionTab; sessionId: string }) {
  const panel = useFiles((s) => s.panels[tab.id]);
  const queue = useFiles((s) => s.queue).filter((t) => t.tabId === tab.id);
  const [selected, setSelected] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [pathInput, setPathInput] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const browse = useFiles((s) => s.browse);
  const path = panel?.path ?? null;

  // Files dropped from the OS file manager upload into the current folder.
  useEffect(() => {
    if (panel?.mode !== "sftp" || !ipc.isTauri()) return;
    let unlisten: (() => void) | undefined;
    const inside = (x: number, y: number) => {
      const r = rootRef.current?.getBoundingClientRect();
      const s = window.devicePixelRatio || 1;
      return !!r && x / s >= r.left && x / s <= r.right && y / s >= r.top && y / s <= r.bottom;
    };
    let webview: ReturnType<typeof getCurrentWebview>;
    try {
      webview = getCurrentWebview();
    } catch {
      return; // No webview (tests, plain browser): uploads still work via the button.
    }
    webview
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "over") setDropping(inside(p.position.x, p.position.y));
        else if (p.type === "leave") setDropping(false);
        else if (p.type === "drop") {
          setDropping(false);
          if (!inside(p.position.x, p.position.y) || !path) return;
          useFiles.getState().enqueue(
            p.paths.map((local) => ({
              tabId: tab.id,
              sessionId,
              protocol: "sftp" as const,
              direction: "upload" as const,
              localPath: local,
              remotePath: joinRemote(path, baseName(local)),
              name: baseName(local),
              size: null,
            })),
          );
        }
      })
      .then((f) => (unlisten = f))
      .catch(() => {});
    return () => unlisten?.();
  }, [panel?.mode, path, sessionId, tab.id]);

  if (!panel?.open) return null;

  const go = (p: string) => {
    setSelected(null);
    void browse(tab.id, sessionId, p);
  };

  async function run(op: ipc.FileOp, failure: string) {
    try {
      await ipc.sftpOp(sessionId, op);
      if (path) go(path);
    } catch (e) {
      useNotifications.getState().notifyError(e, failure);
    }
  }

  async function onPrompt(value: string | null) {
    const p = prompt;
    setPrompt(null);
    if (!p || value === null || !path) return;
    if (p.kind === "mkdir")
      await run({ op: "mkdir", path: joinRemote(path, value) }, "Could not create the folder");
    else if (p.kind === "rename")
      await run(
        { op: "rename", from: p.entry.path, to: joinRemote(path, value) },
        "Could not rename",
      );
    else
      await run(
        { op: "chmod", path: p.entry.path, mode: parseInt(value, 8) },
        "Could not change permissions",
      );
  }

  async function remove(e: RemoteEntry) {
    const ok = await confirmAction({
      title: `Delete ${e.name}?`,
      description:
        e.kind === "dir"
          ? "The folder and everything in it are deleted on the device."
          : "The file is deleted on the device.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (ok) await run({ op: "remove", path: e.path }, `Could not delete ${e.name}`);
  }

  async function download(e: RemoteEntry) {
    const local = await save({ title: `Save ${e.name}`, defaultPath: e.name });
    if (!local) return;
    useFiles.getState().enqueue([
      {
        tabId: tab.id,
        sessionId,
        protocol: "sftp",
        direction: "download",
        localPath: local,
        remotePath: e.path,
        name: e.name,
        size: e.size,
      },
    ]);
  }

  async function upload() {
    const picked = await open({ multiple: true, title: "Files to upload" });
    const files = typeof picked === "string" ? [picked] : (picked ?? []);
    if (!path || files.length === 0) return;
    useFiles.getState().enqueue(
      files.map((local) => ({
        tabId: tab.id,
        sessionId,
        protocol: "sftp" as const,
        direction: "upload" as const,
        localPath: local,
        remotePath: joinRemote(path, baseName(local)),
        name: baseName(local),
        size: null,
      })),
    );
  }

  return (
    <aside
      ref={rootRef}
      aria-label="Files"
      className={cn(
        "flex w-80 shrink-0 flex-col border-l border-border bg-surface text-[13px]",
        dropping && "ring-2 ring-accent ring-inset",
      )}
    >
      <div className="flex items-center gap-1 border-b border-border p-2">
        <SegmentedControl
          label="Transfer protocol"
          value={panel.mode}
          options={[
            { value: "sftp", label: "SFTP" },
            { value: "scp", label: "SCP" },
          ]}
          onChange={(m) => {
            useFiles.getState().setMode(tab.id, m);
            if (m === "sftp" && !panel.entries) go(path ?? "");
          }}
        />
        <span className="flex-1" />
        <Tooltip label="Close files">
          <button
            type="button"
            aria-label="Close files"
            onClick={() => useFiles.getState().toggle(tab.id, sessionId)}
            className="rounded p-1 text-fg-subtle hover:bg-surface-raised hover:text-fg"
          >
            <X size={14} />
          </button>
        </Tooltip>
      </div>

      {panel.mode === "scp" ? (
        <>
          {panel.error && <p className="px-3 pt-3 text-xs text-fg-muted">{panel.error}</p>}
          <ScpForm tab={tab} sessionId={sessionId} />
          <span className="flex-1" />
        </>
      ) : (
        <>
          <div className="flex items-center gap-0.5 border-b border-border p-1">
            <Tooltip label="Up one folder">
              <Button
                size="sm"
                variant="ghost"
                aria-label="Up one folder"
                disabled={!path || path === "/"}
                onClick={() => path && go(parentRemote(path))}
              >
                <ArrowUp size={13} />
              </Button>
            </Tooltip>
            <form
              className="min-w-0 flex-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (pathInput) go(pathInput);
                setPathInput(null);
              }}
            >
              <Input
                aria-label="Folder"
                spellCheck={false}
                className="h-7 font-mono text-xs"
                value={pathInput ?? path ?? ""}
                onChange={(e) => setPathInput(e.target.value)}
                onBlur={() => setPathInput(null)}
              />
            </form>
            <Tooltip label="Refresh">
              <Button size="sm" variant="ghost" aria-label="Refresh" onClick={() => go(path ?? "")}>
                <RefreshCw size={13} />
              </Button>
            </Tooltip>
            <Tooltip label="New folder">
              <Button
                size="sm"
                variant="ghost"
                aria-label="New folder"
                disabled={!path}
                onClick={() => setPrompt({ kind: "mkdir" })}
              >
                <FolderPlus size={13} />
              </Button>
            </Tooltip>
            <Tooltip label="Upload files (or drop them here)">
              <Button
                size="sm"
                variant="ghost"
                aria-label="Upload files"
                disabled={!path}
                onClick={() => void upload()}
              >
                <Upload size={13} />
              </Button>
            </Tooltip>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {panel.error && (
              <p role="alert" className="m-3 rounded-md bg-surface-raised p-2 text-xs text-danger">
                {panel.error}
              </p>
            )}
            {panel.loading && !panel.entries && (
              <div className="flex flex-col gap-1 p-2" aria-busy>
                {Array.from({ length: 8 }, (_, i) => (
                  <Skeleton key={i} className="h-6" />
                ))}
              </div>
            )}
            {panel.entries?.length === 0 && (
              <p className="p-3 text-xs text-fg-subtle">This folder is empty.</p>
            )}
            <ul role="listbox" aria-label="Remote files">
              {panel.entries?.map((e) => {
                const Icon = ICON[e.kind];
                return (
                  <ContextMenu key={e.path}>
                    <ContextMenuTrigger asChild>
                      <li
                        role="option"
                        aria-selected={selected === e.path}
                        tabIndex={-1}
                        onClick={() => setSelected(e.path)}
                        onDoubleClick={() => (e.kind === "dir" ? go(e.path) : void download(e))}
                        className={cn(
                          "flex cursor-default items-center gap-2 px-2 py-1 hover:bg-surface-raised",
                          selected === e.path && "bg-accent-subtle hover:bg-accent-subtle",
                        )}
                      >
                        <Icon
                          size={13}
                          className={cn(
                            "shrink-0",
                            e.kind === "dir" ? "text-accent-text" : "text-fg-subtle",
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate">{e.name}</span>
                        {e.kind !== "dir" && (
                          <span className="shrink-0 font-mono text-[10px] text-fg-subtle">
                            {formatBytes(e.size)}
                          </span>
                        )}
                        <span className="w-8 shrink-0 text-right font-mono text-[10px] text-fg-subtle">
                          {formatMode(e.mode)}
                        </span>
                      </li>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      {e.kind === "dir" ? (
                        <ContextMenuItem icon={<Folder size={14} />} onSelect={() => go(e.path)}>
                          Open
                        </ContextMenuItem>
                      ) : (
                        <ContextMenuItem
                          icon={<Download size={14} />}
                          onSelect={() => void download(e)}
                        >
                          Download…
                        </ContextMenuItem>
                      )}
                      <ContextMenuItem
                        icon={<Pencil size={14} />}
                        onSelect={() => setPrompt({ kind: "rename", entry: e })}
                      >
                        Rename…
                      </ContextMenuItem>
                      <ContextMenuItem
                        icon={<KeyRound size={14} />}
                        onSelect={() => setPrompt({ kind: "chmod", entry: e })}
                      >
                        Permissions…
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem icon={<Trash2 size={14} />} onSelect={() => void remove(e)}>
                        Delete
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
            </ul>
          </div>
        </>
      )}
      <Queue items={queue} />
      {prompt && <PromptDialog prompt={prompt} onDone={(v) => void onPrompt(v)} />}
    </aside>
  );
}
