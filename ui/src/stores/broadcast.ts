import { create } from "zustand";
import * as ipc from "@/lib/ipc";
import { useNotifications } from "./notifications";
import { useSessions } from "./sessions";

interface BroadcastState {
  /** Member tabs; input typed into any of them goes to all. Empty when off. */
  members: string[];
  startedAt: number | null;
  /** The dialog for choosing members. */
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;
  start: (tabIds: string[]) => void;
  stop: () => void;
  /** Drop a closed tab; ends broadcast when fewer than two members remain. */
  removeTab: (tabId: string) => void;
}

function labels(tabIds: string[]): string[] {
  const tabs = useSessions.getState().tabs;
  return tabIds.map((id) => tabs.find((t) => t.id === id)?.title ?? id);
}

function report(e: unknown) {
  useNotifications.getState().notifyError(e, "Could not record broadcast in the audit log");
}

export const useBroadcast = create<BroadcastState>((set, get) => ({
  members: [],
  startedAt: null,
  pickerOpen: false,
  setPickerOpen: (pickerOpen) => set({ pickerOpen }),
  start: (tabIds) => {
    const members = [...new Set(tabIds)];
    if (members.length < 2) return;
    if (get().members.length) get().stop();
    set({ members, startedAt: Date.now(), pickerOpen: false });
    ipc.broadcastStarted(labels(members)).catch(report);
  },
  stop: () => {
    const { members, startedAt } = get();
    if (!members.length) return;
    set({ members: [], startedAt: null });
    const secs = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
    ipc.broadcastEnded(labels(members), secs).catch(report);
  },
  removeTab: (tabId) => {
    const { members } = get();
    if (!members.includes(tabId)) return;
    if (members.length <= 2) get().stop();
    else set({ members: members.filter((m) => m !== tabId) });
  },
}));

/** Other members that should receive input typed into `tabId` (none when off). */
export function broadcastPeers(tabId: string): string[] {
  const { members } = useBroadcast.getState();
  return members.includes(tabId) ? members.filter((m) => m !== tabId) : [];
}
