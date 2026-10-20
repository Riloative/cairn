/** Non-component helpers shared by the inventory views. */

import { EMPTY_SERIAL } from "@/connect/serialForm";
import { consoleTcpPort } from "@/connect/telnetForm";
import type {
  ConnectionMethod,
  CustomField,
  CustomValue,
  Device,
  Interface,
  InventorySnapshot,
  LocationInput,
  LocationKind,
  Vlan,
} from "@/lib/ipc";
import { useInventory } from "@/stores/inventory";
import { hostnameError, isIp, parseVlanList } from "./validate";

type Kind = ConnectionMethod["kind"];

export function defaultMethod(kind: Kind, ip: string): ConnectionMethod {
  switch (kind) {
    case "ssh":
      return { kind, port: 22, username: "", legacy: [], jumps: "", agentForwarding: false };
    case "telnet":
      return { kind, port: 23, raw: false };
    case "console-server":
      return { kind, host: "", server: "opengear", port: 1, raw: false };
    case "serial":
      return {
        kind,
        path: "",
        settings: {
          baud: EMPTY_SERIAL.baud,
          dataBits: EMPTY_SERIAL.dataBits,
          parity: EMPTY_SERIAL.parity,
          stopBits: EMPTY_SERIAL.stopBits,
          flowControl: EMPTY_SERIAL.flowControl,
        },
        newline: { transmit: "cr", receive: "crlf" },
        localEcho: false,
      };
    case "rdp":
      return {
        kind,
        port: 3389,
        username: "",
        domain: "",
        security: "nla",
        width: 0,
        height: 0,
        colorDepth: 32,
        clipboard: true,
        tunnel: "",
        external: false,
      };
    case "web":
      return { kind, url: ip ? `https://${ip.includes(":") ? `[${ip}]` : ip}/` : "https://" };
  }
}

/** Problems that would make the backend reject a method. */
export function methodError(m: ConnectionMethod): string | undefined {
  const port = (p: number) => !Number.isInteger(p) || p < 1 || p > 65535;
  switch (m.kind) {
    case "ssh":
    case "telnet":
      return port(m.port) ? "The port must be 1–65535." : undefined;
    case "rdp": {
      if (port(m.port)) return "The port must be 1–65535.";
      const side = (v: number) => Number.isInteger(v) && v >= 200 && v <= 8192;
      const fit = m.width === 0 && m.height === 0;
      if (!fit && !(side(m.width) && side(m.height)))
        return "The resolution must be 200–8192 pixels per side.";
      if (m.tunnel.trim() && /\s/.test(m.tunnel.trim()))
        return "The SSH tunnel is user@host:port, without spaces.";
      return undefined;
    }
    case "console-server":
      if (!m.host.trim() || /\s/.test(m.host.trim())) return "Enter the console server address.";
      return consoleTcpPort(m.server, m.port) === null ? "Enter a valid port number." : undefined;
    case "serial":
      return m.path.trim() ? undefined : "Enter the serial device path.";
    case "web":
      return /^https?:\/\/\S+$/.test(m.url.trim()) && !/^https?:\/\/$/.test(m.url.trim())
        ? undefined
        : "Enter an http:// or https:// address.";
  }
}

/** Client-side check for a custom value (Rust validates again). */
export function customError(f: CustomField, v: CustomValue | undefined): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  switch (f.kind) {
    case "number":
      return typeof v === "number" && Number.isFinite(v) ? undefined : "Enter a number.";
    case "url":
      return typeof v === "string" && /^https?:\/\/\S+$/.test(v)
        ? undefined
        : "Enter an http(s):// address.";
    case "ip":
      return typeof v === "string" && isIp(v) ? undefined : "Enter a valid IP address.";
    case "date":
      return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? undefined : "Use YYYY-MM-DD.";
    default:
      return undefined;
  }
}

export const NEW_DEVICE: Device = {
  id: 0,
  hostname: "",
  mgmtIp: "",
  deviceType: "switch",
  vendor: "Generic",
  model: "",
  serial: "",
  firmware: "",
  assetNumber: "",
  buildingId: null,
  floorId: null,
  roomId: null,
  rackId: null,
  rackU: null,
  uHeight: 1,
  credentialId: null,
  connections: [
    { kind: "ssh", port: 22, username: "", legacy: [], jumps: "", agentForwarding: false },
  ],
  vlans: [],
  tags: [],
  notes: "",
  custom: {},
  interfaceCount: 0,
  recordSessions: false,
  createdAt: "",
  updatedAt: "",
};

export interface FormState {
  device: Device;
  vlans: string;
  tags: string;
}

export interface FormErrors {
  hostname?: string;
  mgmtIp?: string;
  vlans?: string;
  rackU?: string;
  connections?: string;
  custom?: string;
}

export function validateDevice(f: FormState, snapshot: InventorySnapshot): FormErrors {
  const e: FormErrors = {};
  const d = f.device;
  e.hostname = hostnameError(d.hostname);
  if (d.mgmtIp.trim() && !isIp(d.mgmtIp)) e.mgmtIp = "Enter a valid IPv4 or IPv6 address.";
  if (parseVlanList(f.vlans) === null) e.vlans = "Use VLAN ids and ranges like 10,20-30 (1–4094).";
  const rack = snapshot.racks.find((r) => r.id === d.rackId);
  if (rack && d.rackU !== null) {
    if (d.rackU < 1 || d.rackU + d.uHeight - 1 > rack.heightU)
      e.rackU = `Must fit inside ${rack.name} (U1–U${rack.heightU}).`;
  }
  if (d.connections.some((m) => methodError(m) !== undefined))
    e.connections = "Fix the connection settings above.";
  if (snapshot.fields.some((fd) => customError(fd, d.custom[fd.key]) !== undefined))
    e.custom = "Fix the custom field values.";
  return Object.fromEntries(Object.entries(e).filter(([, v]) => v)) as FormErrors;
}

/** Close the sheet or return to the device after saving. */
export function finishEdit(saved: Device | null, previousId: number | null) {
  const { setSheet } = useInventory.getState();
  if (saved) setSheet({ mode: "view", deviceId: saved.id });
  else if (previousId) setSheet({ mode: "view", deviceId: previousId });
  else setSheet(null);
}

export const IFACE_TEMPLATE: Interface = {
  id: 0,
  deviceId: 0,
  name: "",
  kind: "copper",
  speed: "1G",
  mode: "access",
  accessVlan: null,
  nativeVlan: null,
  allowedVlans: "",
  lag: "",
  description: "",
  enabled: true,
  position: 0,
};

/** A new location of `kind` below `parent`. */
export function blankLocation(kind: LocationKind, parent: number): LocationInput {
  switch (kind) {
    case "site":
      return { kind, id: 0, name: "", notes: "" };
    case "building":
      return { kind, id: 0, siteId: parent, name: "", code: "", address: "", notes: "" };
    case "floor":
      return { kind, id: 0, buildingId: parent, name: "", level: 0, notes: "" };
    case "room":
      return { kind, id: 0, floorId: parent, name: "", notes: "" };
    case "rack":
      return { kind, id: 0, floorId: parent, roomId: null, name: "", heightU: 42, notes: "" };
  }
}

/** A small fixed palette for VLAN colors (reused on the map). */
export const VLAN_COLORS = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#64748b",
];

export function vlanErrors(
  v: Vlan,
): Partial<Record<"vid" | "subnet" | "gateway" | "color", string>> {
  const e: Partial<Record<"vid" | "subnet" | "gateway" | "color", string>> = {};
  if (!Number.isInteger(v.vid) || v.vid < 1 || v.vid > 4094) e.vid = "VLAN ids are 1–4094.";
  if (v.subnet.trim()) {
    const [addr, len, extra] = v.subnet.trim().split("/");
    const max = addr?.includes(":") ? 128 : 32;
    if (
      extra !== undefined ||
      !addr ||
      !isIp(addr) ||
      !/^\d+$/.test(len ?? "") ||
      Number(len) > max
    )
      e.subnet = "Use a prefix like 10.1.20.0/24.";
  }
  if (v.gateway.trim() && !isIp(v.gateway)) e.gateway = "Enter a valid IP address.";
  if (v.color && !/^#[0-9a-fA-F]{6}$/.test(v.color)) e.color = "Use a color like #3b82f6.";
  return e;
}

/** Whether any SSH method of a device enables weak legacy algorithms. */
export function usesLegacySsh(d: Device): boolean {
  return d.connections.some((m) => m.kind === "ssh" && m.legacy.length > 0);
}
