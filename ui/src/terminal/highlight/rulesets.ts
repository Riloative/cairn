import type { HighlightRule, HighlightRuleSet } from "./types";

/**
 * Built-in highlighting rule sets. The common set applies to every session; a vendor set
 * is layered on top (vendor rules win where they overlap). Users can override a set by
 * saving an edited copy with the same id (Settings → Terminal → Highlighting).
 */

function rule(
  id: string,
  name: string,
  pattern: string,
  style: Partial<Pick<HighlightRule, "fg" | "bg" | "bold" | "underline" | "caseInsensitive">>,
): HighlightRule {
  return {
    id,
    name,
    pattern,
    caseInsensitive: style.caseInsensitive ?? false,
    fg: style.fg ?? null,
    bg: style.bg ?? null,
    bold: style.bold ?? false,
    underline: style.underline ?? false,
    enabled: true,
  };
}

const OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
const H16 = "[0-9a-fA-F]{1,4}";

/** IPv4 address with optional prefix length or dotted mask is handled separately. */
export const IPV4 = String.raw`(?<![\d.])${OCTET}(?:\.${OCTET}){3}(?:\/(?:3[0-2]|[12]?\d))?(?![\d.]*\d)`;

/** IPv6 (full, compressed and `::`-prefixed forms) with optional prefix length. */
export const IPV6 = [
  String.raw`(?<![\w:])(?:${H16}:){7}${H16}(?:\/\d{1,3})?(?![\w:])`,
  String.raw`(?<![\w:])(?:${H16}:){1,7}:(?:${H16}(?::${H16}){0,6})?(?:\/\d{1,3})?(?![\w:])`,
  String.raw`(?<![\w:])::(?:${H16}(?::${H16}){0,6})?(?:\/\d{1,3})?(?![\w:])`,
].join("|");

export const MAC = [
  String.raw`\b[0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5}\b`,
  // Cisco dotted (0011.2233.4455)
  String.raw`\b[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\b`,
  // HP/Aruba (001122-334455)
  String.raw`\b[0-9a-fA-F]{6}-[0-9a-fA-F]{6}\b`,
].join("|");

const COMMON: HighlightRuleSet = {
  id: "common",
  name: "Common",
  vendors: ["*"],
  rules: [
    rule("common.err-disabled", "err-disabled", String.raw`\berr-?disabled?\b`, {
      fg: "brightWhite",
      bg: "red",
      bold: true,
      caseInsensitive: true,
    }),
    rule(
      "common.admin-down",
      "administratively down",
      String.raw`\badmin(?:istratively)?[ -]down\b`,
      {
        fg: "yellow",
        bold: true,
        caseInsensitive: true,
      },
    ),
    rule("common.no-shutdown", "no shutdown", String.raw`\b(?:no|undo) shut(?:down)?\b`, {
      fg: "green",
    }),
    rule("common.shutdown", "shutdown", String.raw`\bshut(?:down)?\b`, { fg: "red" }),
    rule("common.ipv6", "IPv6 address / prefix", IPV6, { fg: "cyan" }),
    rule("common.mac", "MAC address", MAC, { fg: "magenta" }),
    rule("common.ipv4", "IPv4 address / prefix", IPV4, { fg: "brightCyan" }),
    rule("common.vlan", "VLAN", String.raw`\b(?:vlan|VLAN|Vlan)[ -]?(?:id )?\d{1,4}\b`, {
      fg: "brightMagenta",
    }),
    rule(
      "common.up",
      "up",
      String.raw`\b(?:up|UP|Up|connected|forwarding|FWD|established|Established)\b`,
      {
        fg: "green",
      },
    ),
    rule("common.down", "down", String.raw`\b(?:down|DOWN|Down|notconnect|blocking|BLK)\b`, {
      fg: "red",
    }),
    rule(
      "common.error",
      "errors",
      String.raw`\b(?:errors?|fail(?:ed|ure|s)?|invalid|denied|refused|critical|crc|giants|runts|collisions?|drops?|unreachable)\b|^%.*`,
      { fg: "brightRed", caseInsensitive: true },
    ),
    rule("common.warning", "warnings", String.raw`\b(?:warn(?:ing)?s?|deprecated|degraded)\b`, {
      fg: "yellow",
      caseInsensitive: true,
    }),
  ],
};

const CISCO_IFACE = String.raw`\b(?:(?:Gi(?:gabitEthernet)?|Te(?:nGigabitEthernet)?|Fa(?:stEthernet)?|Fo(?:rtyGigabitEthernet)?|Hu(?:ndredGigE)?|Twe(?:ntyFiveGigE)?|Tw(?:oGigabitEthernet)?|Fi(?:veGigabitEthernet)?|Eth(?:ernet)?|Po(?:rt-channel)?|Se(?:rial)?|Tu(?:nnel)?|Lo(?:opback)?|Vl(?:an)?|mgmt|Mgmt|Ap|AppGigabitEthernet|nve|BDI|BVI)\d+(?:\/\d+)*(?:\.\d+)?|Nu(?:ll)?0)\b`;

const CISCO: HighlightRuleSet = {
  id: "cisco",
  name: "Cisco IOS / IOS-XE / NX-OS",
  vendors: ["cisco"],
  rules: [
    rule("cisco.interface", "interface names", CISCO_IFACE, { fg: "blue", bold: true }),
    rule(
      "cisco.invalid",
      "% errors",
      String.raw`^% ?(?:Invalid|Incomplete|Ambiguous|Unknown|Bad|Error).*`,
      {
        fg: "brightRed",
        bold: true,
      },
    ),
    rule(
      "cisco.status",
      "status column",
      String.raw`\b(?:disabled|inactive|monitoring|suspended|sfpAbsent)\b`,
      {
        fg: "yellow",
      },
    ),
  ],
};

const JUNOS: HighlightRuleSet = {
  id: "junos",
  name: "Juniper Junos",
  vendors: ["juniper"],
  rules: [
    rule(
      "junos.interface",
      "interface names",
      String.raw`\b(?:ge|xe|et|mge|ae|irb|lo|em|fxp|me|vme|reth|st|gr|ip|lt|fab|swfab|vlan)-?\d+(?:\/\d+)*(?:\.\d+)?\b`,
      { fg: "blue", bold: true },
    ),
    rule(
      "junos.inactive",
      "inactive / deactivate",
      String.raw`\b(?:inactive:|deactivate|disable)\b`,
      {
        fg: "yellow",
      },
    ),
    rule(
      "junos.error",
      "error: / warning:",
      String.raw`^(?:error|syntax error|missing|unknown command).*`,
      {
        fg: "brightRed",
        bold: true,
      },
    ),
  ],
};

const FORTIOS: HighlightRuleSet = {
  id: "fortios",
  name: "Fortinet FortiOS",
  vendors: ["fortinet"],
  rules: [
    rule(
      "fortios.interface",
      "interface names",
      String.raw`\b(?:port\d+|wan\d?|internal\d*|dmz\d?|mgmt\d?|ha\d?|x\d+|a\d|b\d|fortilink|ssl\.root)\b`,
      { fg: "blue", bold: true },
    ),
    rule("fortios.status", "set status", String.raw`\bset status (?:up|down)\b`, { fg: "yellow" }),
    rule(
      "fortios.error",
      "command errors",
      String.raw`^(?:Command fail|command parse error|entry not found|value parse error).*`,
      {
        fg: "brightRed",
        bold: true,
      },
    ),
    rule("fortios.action", "accept / deny", String.raw`\bset action (?:accept|deny)\b`, {
      fg: "magenta",
    }),
  ],
};

const AOSCX: HighlightRuleSet = {
  id: "aoscx",
  name: "ArubaOS-CX",
  vendors: ["aruba", "aruba-cx"],
  rules: [
    rule(
      "aoscx.interface",
      "interface names",
      String.raw`\b(?:\d+\/\d+\/\d+(?:-\d+\/\d+\/\d+)?|lag\s?\d+|vlan\s?\d+|loopback\s?\d+|mgmt)\b`,
      { fg: "blue", bold: true },
    ),
    rule(
      "aoscx.error",
      "invalid input",
      String.raw`^(?:Invalid input|% Command incomplete|Error).*`,
      {
        fg: "brightRed",
        bold: true,
      },
    ),
  ],
};

const PROCURVE: HighlightRuleSet = {
  id: "procurve",
  name: "HP / Aruba ProCurve (AOS-S)",
  vendors: ["hp", "aruba-procurve"],
  rules: [
    rule(
      "procurve.interface",
      "ports and trunks",
      String.raw`\b(?:[A-F]\d{1,2}|Trk\d+|\d{1,2}\/\d{1,2})\b`,
      {
        fg: "blue",
        bold: true,
      },
    ),
    rule("procurve.status", "port status", String.raw`\b(?:Disabled|Blocking|Learning)\b`, {
      fg: "yellow",
    }),
    rule(
      "procurve.error",
      "invalid input",
      String.raw`^(?:Invalid input|Ambiguous input|Incomplete input).*`,
      {
        fg: "brightRed",
        bold: true,
      },
    ),
  ],
};

const COMWARE: HighlightRuleSet = {
  id: "comware",
  name: "HP / H3C Comware",
  vendors: ["hp-comware", "h3c"],
  rules: [
    rule(
      "comware.interface",
      "interface names",
      String.raw`\b(?:(?:GigabitEthernet|Ten-GigabitEthernet|FortyGigE|HundredGigE|Twenty-FiveGigE|GE|XGE|FGE|HGE|WGE|M-GigabitEthernet|MGE|Bridge-Aggregation|BAGG|Route-Aggregation|RAGG|Vlan-interface|Vlan-int|LoopBack|Loop|NULL)\d+(?:\/\d+)*(?:\.\d+)?)\b`,
      { fg: "blue", bold: true },
    ),
    rule("comware.adm", "ADM (admin down)", String.raw`\b(?:ADM|\*down)\b`, {
      fg: "yellow",
      bold: true,
    }),
    rule(
      "comware.error",
      "unrecognized command",
      String.raw`^\s*% ?(?:Unrecognized|Incomplete|Too many|Wrong).*`,
      {
        fg: "brightRed",
        bold: true,
      },
    ),
  ],
};

const EDGEOS: HighlightRuleSet = {
  id: "edgeos",
  name: "Ubiquiti UniFi / EdgeOS",
  vendors: ["ubiquiti"],
  rules: [
    rule(
      "edgeos.interface",
      "interface names",
      String.raw`\b(?:eth\d+(?:\.\d+)?|switch\d+(?:\.\d+)?|br\d+|pppoe\d+|wg\d+|vtun\d+|imq\d+|lo|ra\d+|ath\d+|wifi\d+)\b`,
      { fg: "blue", bold: true },
    ),
    rule("edgeos.state", "u/u, A/D", String.raw`\b(?:u\/u|A\/D|u\/D|D\/D)\b`, { fg: "yellow" }),
  ],
};

const LINUX: HighlightRuleSet = {
  id: "linux",
  name: "Linux / servers",
  vendors: ["generic", "dell", "mikrotik"],
  rules: [
    rule(
      "linux.interface",
      "interface names",
      String.raw`\b(?:eth\d+|en[ops]\w+|wl\w+|bond\d+|br-?\w+|vlan\d+|veth\w+|docker\d|virbr\d|tun\d|tap\d|wg\d+)\b`,
      { fg: "blue" },
    ),
  ],
};

export const BUILTIN_RULESETS: readonly HighlightRuleSet[] = [
  COMMON,
  CISCO,
  JUNOS,
  FORTIOS,
  AOSCX,
  PROCURVE,
  COMWARE,
  EDGEOS,
  LINUX,
];

/** Vendors selectable for a session (and, from M4, a device's vendor field). */
export const VENDORS: readonly { id: string; label: string }[] = [
  { id: "generic", label: "Generic" },
  { id: "cisco", label: "Cisco" },
  { id: "juniper", label: "Juniper" },
  { id: "fortinet", label: "Fortinet" },
  { id: "aruba-cx", label: "Aruba (AOS-CX)" },
  { id: "aruba-procurve", label: "Aruba / HP ProCurve" },
  { id: "hp-comware", label: "HP / H3C Comware" },
  { id: "ubiquiti", label: "Ubiquiti" },
  { id: "mikrotik", label: "MikroTik" },
  { id: "dell", label: "Dell" },
];
