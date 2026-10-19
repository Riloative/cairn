import { useState } from "react";
import { BackupDialog } from "@/backup/BackupDialog";
import { RestoreDialog } from "@/backup/RestoreDialog";
import { Button } from "@/components/ui/Button";
import { Row } from "./Row";

/** Settings → Backup: encrypted full backup and restore. */
export function BackupSettings() {
  const [dialog, setDialog] = useState<"backup" | "restore" | null>(null);
  return (
    <section>
      <Row
        title="Create a backup"
        description="One encrypted file with everything: inventory, credentials, settings, snippets, floor plans, config snapshots, the audit log and, if you like, session recordings. It has its own password."
      >
        <Button onClick={() => setDialog("backup")}>Create backup…</Button>
      </Row>
      <Row
        title="Restore a backup"
        description="Replace everything in Cairn on this computer with a backup. Requires the backup's password and your master password."
      >
        <Button onClick={() => setDialog("restore")}>Restore…</Button>
      </Row>
      {dialog === "backup" && <BackupDialog onClose={() => setDialog(null)} />}
      {dialog === "restore" && <RestoreDialog mode="replace" onClose={() => setDialog(null)} />}
    </section>
  );
}
