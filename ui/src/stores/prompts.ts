import { create } from "zustand";
import * as ipc from "@/lib/ipc";
import type { CertInfo, HostKeyInfo, HostKeyStatus, PromptAnswer, SshPrompt } from "@/lib/ipc";

export type PendingPrompt =
  | {
      id: number;
      tabId: string;
      type: "host_key";
      info: HostKeyInfo;
      status: HostKeyStatus;
      openssh: "match" | "mismatch" | "unknown";
    }
  | { id: number; tabId: string; type: "prompt"; prompt: SshPrompt }
  | { id: number; tabId: string; type: "certificate"; cert: CertInfo; status: HostKeyStatus };

interface PromptsState {
  /** Oldest first; the UI shows the first one. */
  queue: PendingPrompt[];
  push: (p: PendingPrompt) => void;
  /** Send the answer to the backend and remove the prompt. */
  answer: (id: number, answer: PromptAnswer) => Promise<void>;
  /** Forget prompts of a closed tab (the backend already dropped them). */
  dropTab: (tabId: string) => void;
  /**
   * Reject every pending prompt (on lock): host keys and certificates are refused,
   * credential prompts cancelled, so the waiting connections fail instead of hanging.
   */
  cancelAll: () => void;
}

export const usePrompts = create<PromptsState>((set, get) => ({
  queue: [],
  push: (p) => set({ queue: [...get().queue, p] }),
  answer: async (id, answer) => {
    set({ queue: get().queue.filter((p) => p.id !== id) });
    await ipc.sessionPromptReply(id, answer);
  },
  dropTab: (tabId) => set({ queue: get().queue.filter((p) => p.tabId !== tabId) }),
  cancelAll: () => {
    const queue = get().queue;
    set({ queue: [] });
    for (const p of queue) {
      const answer: PromptAnswer =
        p.type === "prompt" ? { kind: "cancel" } : { kind: "hostKey", accept: false };
      // Best effort: an unknown id means the session already went away.
      ipc.sessionPromptReply(p.id, answer).catch(() => {});
    }
  },
}));
