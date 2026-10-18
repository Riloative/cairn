import { create } from "zustand";

export interface ConfirmRequest {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
}

interface ConfirmState {
  request: (ConfirmRequest & { resolve: (ok: boolean) => void }) | null;
  ask: (r: ConfirmRequest) => Promise<boolean>;
  answer: (ok: boolean) => void;
}

/** One confirmation at a time; `ConfirmDialog` renders it. */
export const useConfirm = create<ConfirmState>((set, get) => ({
  request: null,
  ask: (r) =>
    new Promise<boolean>((resolve) => {
      get().request?.resolve(false);
      set({ request: { ...r, resolve } });
    }),
  answer: (ok) => {
    get().request?.resolve(ok);
    set({ request: null });
  },
}));

export const confirmAction = (r: ConfirmRequest) => useConfirm.getState().ask(r);
