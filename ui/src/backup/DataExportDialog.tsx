import { save } from "@tauri-apps/plugin-dialog";
import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import * as ipc from "@/lib/ipc";
import { useNotifications } from "@/stores/notifications";

const FORMATS = [
  { value: "json", label: "JSON (one file)" },
  { value: "csv", label: "CSV (a folder of tables)" },
] as const;

/** Readable export of the inventory; credentials only after an explicit opt-in. */
export function DataExportDialog({ onClose }: { onClose: () => void }) {
  const [format, setFormat] = useState<"json" | "csv">("json");
  const [credentials, setCredentials] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notify = useNotifications((s) => s.notify);

  async function run() {
    const stamp = new Date().toISOString().slice(0, 10);
    const path = await save({
      title: format === "json" ? "Export inventory" : "Name the folder for the CSV files",
      defaultPath: format === "json" ? `cairn-inventory-${stamp}.json` : `cairn-inventory-${stamp}`,
      filters: format === "json" ? [{ name: "JSON", extensions: ["json"] }] : undefined,
    });
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      const files = await ipc.dataExport(format, path, credentials);
      notify({
        variant: credentials ? "warning" : "success",
        title: credentials ? "Exported, including passwords" : "Inventory exported",
        description: files.length === 1 ? (files[0] ?? path) : `${files.length} files in ${path}`,
      });
      onClose();
    } catch (e) {
      setError(ipc.CommandError.from(e).message);
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        title="Export inventory"
        description="Locations, devices, interfaces, links and VLANs as readable files for spreadsheets and other tools. Not encrypted; for a complete, encrypted copy use a backup."
        className="w-[min(520px,calc(100vw-32px))]"
      >
        <div className="flex flex-col gap-4">
          <SegmentedControl label="Format" value={format} options={FORMATS} onChange={setFormat} />
          <label className="flex items-center gap-2 text-[13px]">
            <Switch
              checked={credentials}
              onCheckedChange={(v) => {
                setCredentials(v);
                setUnderstood(false);
              }}
              aria-label="Include credentials"
              disabled={busy}
            />
            Include credential profiles and their secrets
          </label>
          {credentials && (
            <div
              role="alert"
              className="flex gap-3 rounded-lg border border-danger/40 bg-danger/10 p-3 text-[13px]"
            >
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" />
              <div className="flex flex-col gap-2">
                <p>
                  <span className="font-medium">Passwords, enable secrets and private keys</span>{" "}
                  <span className="text-fg-muted">
                    are written in plain text. Anyone who gets the file can log in to your devices.
                    Store it encrypted and delete it when done.
                  </span>
                </p>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--accent)]"
                    checked={understood}
                    onChange={(e) => setUnderstood(e.target.checked)}
                  />
                  I understand the export contains secrets in plain text
                </label>
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={credentials ? "danger" : "primary"}
            disabled={busy || (credentials && !understood)}
            onClick={() => void run()}
          >
            {busy ? "Exporting…" : credentials ? "Export with secrets" : "Export"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
