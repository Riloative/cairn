import { create } from "zustand";
import * as ipc from "@/lib/ipc";
import type { LockReason, VaultInfo } from "@/lib/ipc";

interface VaultState {
  info: VaultInfo | null;
  /** Why the vault last locked itself, shown on the lock screen. */
  lockReason: LockReason | null;
  refresh: () => Promise<void>;
  setup: (password: string) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  lock: () => Promise<void>;
  /** Called when the backend locks on its own (idle, sleep). */
  lockedByBackend: (reason: LockReason) => void;
}

export const useVault = create<VaultState>((set, get) => ({
  info: null,
  lockReason: null,
  refresh: async () => set({ info: await ipc.vaultStatus() }),
  setup: async (password) => set({ info: await ipc.vaultSetup(password), lockReason: null }),
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
