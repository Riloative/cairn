import type { DeviceType, FieldKind, InterfaceKind } from "@/lib/ipc";

export const DEVICE_TYPES: readonly { value: DeviceType; label: string }[] = [
  { value: "switch", label: "Switch" },
  { value: "router", label: "Router" },
  { value: "firewall", label: "Firewall" },
  { value: "server", label: "Server" },
  { value: "access-point", label: "Access point" },
  { value: "wireless-controller", label: "Wireless controller" },
  { value: "storage", label: "Storage" },
  { value: "hypervisor", label: "Hypervisor host" },
  { value: "pdu", label: "PDU" },
  { value: "ups", label: "UPS" },
  { value: "patch-panel", label: "Patch panel" },
  { value: "camera", label: "Camera" },
  { value: "ip-phone", label: "IP phone" },
  { value: "generic", label: "Generic" },
];

export const DEVICE_TYPE_LABEL = Object.fromEntries(
  DEVICE_TYPES.map((t) => [t.value, t.label]),
) as Record<DeviceType, string>;

export const INTERFACE_KINDS: readonly { value: InterfaceKind; label: string }[] = [
  { value: "copper", label: "Copper" },
  { value: "sfp", label: "SFP" },
  { value: "sfp-plus", label: "SFP+" },
  { value: "qsfp", label: "QSFP" },
  { value: "fiber", label: "Fiber" },
  { value: "wireless", label: "Wireless" },
  { value: "virtual", label: "Virtual" },
  { value: "lag", label: "LAG" },
];

export const FIELD_KINDS: readonly { value: FieldKind; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "select", label: "Select" },
  { value: "multi-select", label: "Multi-select" },
  { value: "date", label: "Date" },
  { value: "url", label: "URL" },
  { value: "ip", label: "IP address" },
  { value: "boolean", label: "Yes / no" },
];

/** Highlighting rule set for an inventory vendor (see terminal/highlight/rulesets). */
export function highlightVendor(vendor: string): string {
  switch (vendor.toLowerCase()) {
    case "cisco":
      return "cisco";
    case "juniper":
      return "juniper";
    case "fortinet":
      return "fortinet";
    case "aruba":
      return "aruba-cx";
    case "hp":
      return "aruba-procurve";
    case "ubiquiti":
      return "ubiquiti";
    case "mikrotik":
      return "mikrotik";
    case "dell":
      return "dell";
    default:
      return "generic";
  }
}
