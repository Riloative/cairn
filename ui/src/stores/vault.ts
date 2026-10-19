import { create } from "zustand";
import * as ipc from "@/lib/ipc";
import type { LockReason, VaultInfo } from "@/lib/ipc";

interface VaultState {
  info: VaultInfo | null;
  /** Why the vault last locked itself, shown on the lock screen. */
  lockReason: LockReason | null;
  refresh: () => Promise<void>;
  setup: (password: string) => Promise<void>;
  /** Set after first-run setup, until the backup offer is answered. */
  justCreated: boolean;
  dismissBackupOffer: () => void;
  /** Replace all data with a backup (see `ipc.backupRestore`). */
  restore: (path: string, backupPassword: string, masterPassword: string) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  lock: () => Promise<void>;
  /** Called when the backend locks on its own (idle, sleep). */
  lockedByBackend: (reason: LockReason) => void;
}

export const useVault = create<VaultState>((set, get) => ({
  info: null,
  lockReason: null,
  refresh: async () => set({ info: await ipc.vaultStatus() }),
  setup: async (password) =>
    set({ info: await ipc.vaultSetup(password), lockReason: null, justCreated: true }),
  justCreated: false,
  dismissBackupOffer: () => set({ justCreated: false }),
  restore: async (path, backupPassword, masterPassword) =>
    set({
      info: await ipc.backupRestore(path, backupPassword, masterPassword),
      lockReason: null,
      justCreated: false,
    }),
  unlock: async (password) => {
    try {
      set({ info: await ipc.vaultUnlock(password), lockReason: null });
    } catch (e) {
      // Refresh so the failed-attempt counter is current, then rethrow for the form.
      await get().refresh();
      throw e;
    }
  },
  lock: async () => set({ info: await ipc.vaultLock(), lockReason: "manual" }),
  lockedByBackend: (reason) => {
    const info = get().info;
    set({ info: info ? { ...info, status: "locked" } : info, lockReason: reason });
  },
}));
