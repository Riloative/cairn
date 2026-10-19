import { describe, expect, it } from "vitest";
import type { PortInfo } from "@/lib/ipc";
import { buildSerial, EMPTY_SERIAL, lineSummary, pickPort, validateSerial } from "./serialForm";
import { buildTelnet, consoleTcpPort, EMPTY_TELNET, validateTelnet } from "./telnetForm";

const port = (path: string, usb = true): PortInfo => ({
  path,
  label: path,
  chip: null,
  vid: null,
  pid: null,
  serialNumber: null,
  usb,
});

describe("telnet form", () => {
  it("builds a direct connection with the default port", () => {
    const built = buildTelnet({ ...EMPTY_TELNET, destination: "sw1" });
    expect(built?.request).toEqual({
      host: "sw1",
      port: 23,
      raw: false,
      console: null,
      connectTimeoutSecs: 10,
    });
    expect(built?.title).toBe("sw1");
    expect(buildTelnet({ ...EMPTY_TELNET, destination: "[fe80::1]:2001" })?.title).toBe(
      "[fe80::1]:2001",
    );
  });

  it("maps console-server ports like the backend", () => {
    expect(consoleTcpPort("opengear", 7)).toBe(2007);
    expect(consoleTcpPort("avocent", 1)).toBe(7001);
    expect(consoleTcpPort("digi", 0)).toBeNull();
    expect(consoleTcpPort("avocent", 60000)).toBeNull();
    const built = buildTelnet({
      ...EMPTY_TELNET,
      destination: "cs1",
      console: "cisco-line",
      consolePort: 33,
    });
    expect(built?.request.console).toEqual({ kind: "cisco-line", port: 33 });
    expect(built?.title).toBe("cs1 port 33");
  });

  it("rejects bad input", () => {
    expect(validateTelnet({ ...EMPTY_TELNET, destination: "" }).destination).toBeTruthy();
    expect(validateTelnet({ ...EMPTY_TELNET, destination: "u@h" }).destination).toBeTruthy();
    expect(
      validateTelnet({ ...EMPTY_TELNET, destination: "cs:2001", console: "opengear" }).destination,
    ).toBeTruthy();
    expect(
      validateTelnet({ ...EMPTY_TELNET, destination: "cs", console: "opengear", consolePort: 0 })
        .consolePort,
    ).toBeTruthy();
  });
});

describe("serial form", () => {
  it("defaults to 9600 8N1 and builds options", () => {
    expect(lineSummary(EMPTY_SERIAL)).toBe("9600 8N1");
    const built = buildSerial({ ...EMPTY_SERIAL, path: "/dev/ttyUSB0", localEcho: true });
    expect(built?.title).toBe("ttyUSB0 · 9600 8N1");
    expect(built?.options).toEqual({
      path: "/dev/ttyUSB0",
      settings: {
        baud: 9600,
        dataBits: "eight",
        parity: "none",
        stopBits: "one",
        flowControl: "none",
      },
      newline: { transmit: "cr", receive: "crlf" },
      localEcho: true,
    });
  });

  it("validates port and baud", () => {
    expect(validateSerial(EMPTY_SERIAL).path).toBeTruthy();
    expect(validateSerial({ ...EMPTY_SERIAL, path: "COM3", baud: 0 }).baud).toBeTruthy();
    expect(validateSerial({ ...EMPTY_SERIAL, path: "COM3", baud: 115200 })).toEqual({});
  });

  it("keeps the chosen port while present", () => {
    const ports = [port("/dev/ttyUSB0"), port("/dev/ttyS0", false)];
    expect(pickPort("", ports)).toBe("/dev/ttyUSB0");
    expect(pickPort("/dev/ttyS0", ports)).toBe("/dev/ttyS0");
    expect(pickPort("/dev/ttyUSB9", ports)).toBe("/dev/ttyUSB0");
    expect(pickPort("/dev/ttyUSB9", [])).toBe("/dev/ttyUSB9");
  });
});
