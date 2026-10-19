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

  it("summarizes inventory changes and secret access", () => {
    expect(
      summarize(
        entry("inventory_changed", {
          entity: "device",
          name: "sw1",
          action: "updated",
          changes: [{ field: "model" }, { field: "mgmtIp" }],
        }),
      ),
    ).toBe("device sw1 updated: model, mgmtIp");
    expect(
      summarize(
        entry("inventory_changed", {
          entity: "custom_field",
          name: "Owner",
          action: "deleted",
          changes: [],
        }),
      ),
    ).toBe("custom field Owner deleted");
    expect(summarize(entry("credential_copied", { name: "Lab", field: "password" }))).toBe(
      "password of Lab",
    );
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

  it("summarizes the M6 tool events", () => {
    for (const kind of ["broadcast_started", "config_grabbed", "port_forward", "tftp_server"])
      expect(LABELS[kind]).toBeTruthy();
    expect(summarize(entry("broadcast_ended", { targets: ["sw1", "sw2"], durationSecs: 42 }))).toBe(
      "to sw1, sw2 after 42 s",
    );
    expect(
      summarize(
        entry("config_grabbed", {
          device: "sw1",
          bytes: 2048,
          changed: true,
          ok: true,
          error: null,
        }),
      ),
    ).toBe("sw1: 2048 bytes, changed");
    expect(
      summarize(
        entry("port_forward", {
          forward: "L 127.0.0.1:8443 → 10.0.0.5:443",
          target: "admin@sw1",
          action: "failed",
          error: "Port in use",
        }),
      ),
    ).toBe("L 127.0.0.1:8443 → 10.0.0.5:443 on admin@sw1 failed: Port in use");
    expect(
      summarize(
        entry("file_transferred", {
          sessionId: "tftp 10.0.0.9:50123",
          protocol: "tftp",
          direction: "download",
          file: "sw1.cfg",
          bytes: 900,
          ok: true,
        }),
      ),
    ).toBe("sw1.cfg received from 10.0.0.9:50123 (900 bytes, tftp)");
    expect(
      summarize(
        entry("tftp_server", {
          action: "started",
          bind: "0.0.0.0:6969",
          root: "/srv/tftp",
          allowWrite: true,
        }),
      ),
    ).toBe("started on 0.0.0.0:6969 serving /srv/tftp (uploads allowed)");
  });
});
