import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useVault } from "@/stores/vault";
import { BackupDialog } from "./BackupDialog";

/**
 * Right after first-run setup: offer an encrypted backup (SPEC §9). Shown once; the
 * Settings → Backup tab offers it any time.
 */
export function BackupOffer() {
  const show = useVault((s) => s.justCreated);
  const dismiss = useVault((s) => s.dismissBackupOffer);
  const [open, setOpen] = useState(true);
  if (!show || !open) return null;
  const close = () => {
    setOpen(false);
    dismiss();
  };
  return (
    <BackupDialog
      onClose={close}
      intro={
        <div className="mb-4 flex gap-3 rounded-lg bg-surface-raised p-3 text-[13px]">
          <ShieldCheck size={18} className="mt-0.5 shrink-0 text-accent" />
          <p className="text-fg-muted">
            <span className="font-medium text-fg">Your vault is ready.</span> A lost master password
            cannot be recovered, but a backup with its own password can be restored on any computer.
            You can also make one later in Settings → Backup.
          </p>
        </div>
      }
    />
  );
}
