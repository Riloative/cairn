import { create } from "zustand";
import { getAppInfo, isTauri, type AppInfo } from "@/lib/ipc";

interface AppInfoState {
  info: AppInfo | null;
  error: string | null;
  load: () => Promise<void>;
}

export const useAppInfo = create<AppInfoState>((set) => ({
  info: null,
  error: null,
  load: async () => {
    if (!isTauri()) {
      set({ error: "Not running inside the Cairn desktop shell." });
      return;
    }
    try {
      set({ info: await getAppInfo(), error: null });
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));
