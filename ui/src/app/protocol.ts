import type { SessionProtocol, SessionState } from "@/stores/sessions";

/** Tailwind classes for each protocol's color dot (tokens in tokens.css). */
export const PROTOCOL_DOT: Record<SessionProtocol, string> = {
  ssh: "bg-proto-ssh",
  telnet: "bg-proto-telnet",
  serial: "bg-proto-serial",
  rdp: "bg-proto-rdp",
  local: "bg-proto-local",
};

export const PROTOCOL_LABEL: Record<SessionProtocol, string> = {
  ssh: "SSH",
  telnet: "Telnet",
  serial: "Serial",
  rdp: "RDP",
  local: "Local shell",
};

export const STATE_LABEL: Record<SessionState, string> = {
  connecting: "Connecting",
  connected: "Connected",
  disconnected: "Disconnected",
  error: "Error",
};
