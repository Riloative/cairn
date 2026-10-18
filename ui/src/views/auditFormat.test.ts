import { describe, expect, it } from "vitest";
import type { AuditEntry } from "@/lib/ipc";
import { LABELS, summarize } from "./auditFormat";

const entry = (kind: string, payload: Record<string, unknown>): AuditEntry => ({
  seq: 1,
  ts: "2026-01-01T00:00:00Z",
  kind,
  payload: { kind, ...payload },
  prevHash: "",
  hash: "",
});

describe("audit summaries", () => {
  it("labels every session and transfer event", () => {
    for (const kind of ["session_started", "session_ended", "file_transferred", "host_key_trusted"])
      expect(LABELS[kind]).toBeTruthy();
  });

  it("summarizes sessions and transfers", () => {
    expect(
      summarize(entry("session_started", { protocol: "serial", target: "/dev/ttyUSB0 9600 8N1" })),
    ).toBe("serial /dev/ttyUSB0 9600 8N1");
    expect(
      summarize(
        entry("file_transferred", {
          protocol: "serial",
          direction: "upload",
          file: "c2960.bin",
          bytes: 1024,
          ok: true,
        }),
      ),
    ).toBe("c2960.bin sent (1024 bytes, serial)");
    expect(
      summarize(
        entry("file_transferred", {
          protocol: "serial",
          direction: "download",
          file: "",
          bytes: 0,
          ok: false,
          error: "The transfer was cancelled.",
        }),
      ),
    ).toBe("file not received: The transfer was cancelled.");
  });
});
