import type { ConsoleServerKind, TelnetRequest } from "@/lib/ipc";
import { parseTarget } from "@/ssh/parse";

export type ConsoleChoice = "none" | ConsoleServerKind;

export interface TelnetForm {
  /** `host` or `host:port`. */
  destination: string;
  raw: boolean;
  console: ConsoleChoice;
  /** Physical console-server port (1-based). */
  consolePort: number;
  vendor: string;
}

export const EMPTY_TELNET: TelnetForm = {
  destination: "",
  raw: false,
  console: "none",
  consolePort: 1,
  vendor: "generic",
};

export const CONSOLE_SERVERS: readonly { value: ConsoleChoice; label: string; base?: number }[] = [
  { value: "none", label: "None (direct)" },
  { value: "opengear", label: "Opengear", base: 2000 },
  { value: "cisco-line", label: "Cisco terminal server (line)", base: 2000 },
  { value: "avocent", label: "Avocent / Cyclades ACS", base: 7000 },
  { value: "lantronix", label: "Lantronix SLC", base: 2000 },
  { value: "digi", label: "Digi PortServer / Connect", base: 2000 },
];

/** TCP port for a console-server port (mirrors `ConsoleServerKind::tcp_port`). */
export function consoleTcpPort(kind: ConsoleChoice, port: number): number | null {
  const base = CONSOLE_SERVERS.find((c) => c.value === kind)?.base;
  if (base === undefined || !Number.isInteger(port) || port < 1) return null;
  const tcp = base + port;
  return tcp <= 65535 ? tcp : null;
}

export type TelnetErrors = Partial<Record<"destination" | "consolePort", string>>;

export function validateTelnet(form: TelnetForm): TelnetErrors {
  const errors: TelnetErrors = {};
  const target = parseTarget(form.destination);
  if (!target || target.user) errors.destination = "Enter a host or host:port.";
  if (form.console !== "none") {
    if (target?.port) errors.destination = "Leave out the port; it comes from the console port.";
    if (consoleTcpPort(form.console, form.consolePort) === null)
      errors.consolePort = "Enter a port number from 1 upwards.";
  }
  return errors;
}

export function buildTelnet(form: TelnetForm): { request: TelnetRequest; title: string } | null {
  if (Object.keys(validateTelnet(form)).length > 0) return null;
  const target = parseTarget(form.destination);
  if (!target) return null;
  const consoled = form.console !== "none";
  const request: TelnetRequest = {
    host: target.host,
    port: target.port ?? 23,
    raw: form.raw,
    console: form.console === "none" ? null : { kind: form.console, port: form.consolePort },
    connectTimeoutSecs: 10,
  };
  const host = target.host.includes(":") ? `[${target.host}]` : target.host;
  const title = consoled
    ? `${host} port ${form.consolePort}`
    : target.port && target.port !== 23
      ? `${host}:${target.port}`
      : host;
  return { request, title };
}
