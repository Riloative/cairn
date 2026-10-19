import { useDataDialog } from "@/stores/backupUi";
import { BackupDialog } from "./BackupDialog";
import { DataExportDialog } from "./DataExportDialog";
import { RestoreDialog } from "./RestoreDialog";

/** The backup, restore and export dialogs, opened from Settings or the palette. */
export function DataDialogs() {
  const open = useDataDialog((s) => s.open);
  const set = useDataDialog((s) => s.set);
  const close = () => set(null);
  switch (open) {
    case "backup":
      return <BackupDialog onClose={close} />;
    case "restore":
      return <RestoreDialog mode="replace" onClose={close} />;
    case "export":
      return <DataExportDialog onClose={close} />;
    case null:
      return null;
  }
}
