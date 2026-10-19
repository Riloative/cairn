import { Button } from "@/components/ui/Button";
import { useDataDialog } from "@/stores/backupUi";
import { Row } from "./Row";

/** Settings → Backup: encrypted full backup, restore and readable export. */
export function BackupSettings() {
  const open = useDataDialog((s) => s.set);
  return (
    <section>
      <Row
        title="Create a backup"
        description="One encrypted file with everything: inventory, credentials, settings, snippets, floor plans, config snapshots, the audit log and, if you like, session recordings. It has its own password."
      >
        <Button onClick={() => open("backup")}>Create backup…</Button>
      </Row>
      <Row
        title="Restore a backup"
        description="Replace everything in Cairn on this computer with a backup. Requires the backup's password and your master password."
      >
        <Button onClick={() => open("restore")}>Restore…</Button>
      </Row>
      <Row
        title="Export inventory"
        description="Locations, devices, interfaces, links and VLANs as JSON or CSV, for spreadsheets and other tools. Credentials only if you ask for them."
      >
        <Button onClick={() => open("export")}>Export…</Button>
      </Row>
    </section>
  );
}
