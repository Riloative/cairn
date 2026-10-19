import type { RecordingInfo } from "@/lib/ipc";

/** The device's name, or the address for ad-hoc sessions. */
export function recordingTitle(r: RecordingInfo): string {
  return r.device || r.target;
}
