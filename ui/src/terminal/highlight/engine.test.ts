import { describe, expect, it } from "vitest";
import { compileRule, findMatches, patternError, rulesForVendor } from "./engine";
import { BUILTIN_RULESETS, VENDORS } from "./rulesets";
import type { HighlightRuleSet } from "./types";

const cisco = rulesForVendor("cisco", BUILTIN_RULESETS);
const juniper = rulesForVendor("juniper", BUILTIN_RULESETS);
const comware = rulesForVendor("hp-comware", BUILTIN_RULESETS);
const generic = rulesForVendor("generic", BUILTIN_RULESETS);

/** [matched text, rule id] pairs for readable assertions. */
function hits(line: string, rules = cisco) {
  return findMatches(line, rules).map((m) => [line.slice(m.start, m.end), m.ruleId]);
}

describe("built-in rule sets", () => {
  it("compile cleanly", () => {
    for (const set of BUILTIN_RULESETS) {
      for (const r of set.rules) expect(compileRule(r), r.id).not.toBeNull();
    }
  });

  it("cover every vendor in the picker", () => {
    for (const v of VENDORS) {
      expect(
        BUILTIN_RULESETS.some((s) => s.vendors.includes(v.id)),
        v.id,
      ).toBe(true);
    }
  });
});

describe("Cisco output", () => {
  it("show ip interface brief", () => {
    expect(
      hits("GigabitEthernet0/0     10.1.1.1        YES NVRAM  up                    up"),
    ).toEqual([
      ["GigabitEthernet0/0", "cisco.interface"],
      ["10.1.1.1", "common.ipv4"],
      ["up", "common.up"],
      ["up", "common.up"],
    ]);
    expect(
      hits("GigabitEthernet0/1     unassigned      YES NVRAM  administratively down down"),
    ).toEqual([
      ["GigabitEthernet0/1", "cisco.interface"],
      ["administratively down", "common.admin-down"],
      ["down", "common.down"],
    ]);
  });

  it("show interfaces status with err-disabled", () => {
    expect(hits("Gi1/0/5   uplink   err-disabled 10   auto   auto 10/100/1000BaseTX")).toEqual([
      ["Gi1/0/5", "cisco.interface"],
      ["err-disabled", "common.err-disabled"],
    ]);
  });

  it("vendor interface names win over the common VLAN rule", () => {
    expect(hits("Vlan10                 192.168.10.1    YES manual up    up")[0]).toEqual([
      "Vlan10",
      "cisco.interface",
    ]);
  });

  it("no shutdown vs shutdown", () => {
    expect(hits(" no shutdown")).toEqual([["no shutdown", "common.no-shutdown"]]);
    expect(hits(" shutdown")).toEqual([["shutdown", "common.shutdown"]]);
  });

  it("% error lines", () => {
    expect(hits("% Invalid input detected at '^' marker.")[0]).toEqual([
      "% Invalid input detected at '^' marker.",
      "cisco.invalid",
    ]);
  });

  it("MAC address table", () => {
    expect(hits("  10    0011.2233.4455    DYNAMIC     Gi1/0/1")).toEqual([
      ["0011.2233.4455", "common.mac"],
      ["Gi1/0/1", "cisco.interface"],
    ]);
  });
});

describe("addresses", () => {
  it.each([
    ["ip address 10.0.0.1 255.255.255.0", ["10.0.0.1", "255.255.255.0"]],
    ["route 10.0.0.0/8 via 192.0.2.1", ["10.0.0.0/8", "192.0.2.1"]],
    ["inet6 2001:db8::1/64 scope global", ["2001:db8::1/64"]],
    ["link-local fe80::1ff:fe23:4567:890a", ["fe80::1ff:fe23:4567:890a"]],
    ["mac 00:1a:2b:3c:4d:5e and aa-bb-cc-dd-ee-ff", ["00:1a:2b:3c:4d:5e", "aa-bb-cc-dd-ee-ff"]],
  ])("%s", (line, expected) => {
    const found = findMatches(line, generic)
      .filter((m) => ["common.ipv4", "common.ipv6", "common.mac"].includes(m.ruleId))
      .map((m) => line.slice(m.start, m.end));
    expect(found).toEqual(expected);
  });

  it.each(["1.2.3.4.5", "999.1.1.1", "10.0.0.256", "uptime 12:34:56", "version 15.2.4"])(
    "does not mistake %j for an address",
    (line) => {
      const ids = findMatches(line, generic).map((m) => m.ruleId);
      expect(ids).not.toContain("common.ipv4");
      expect(ids).not.toContain("common.ipv6");
    },
  );
});

describe("other vendors", () => {
  it("Junos interfaces terse", () => {
    expect(hits("ge-0/0/1.0              up    up   inet     10.0.0.1/30", juniper)).toEqual([
      ["ge-0/0/1.0", "junos.interface"],
      ["up", "common.up"],
      ["up", "common.up"],
      ["10.0.0.1/30", "common.ipv4"],
    ]);
  });

  it("Comware brief", () => {
    expect(hits("GE1/0/1              DOWN auto    A    A    1", comware)).toEqual([
      ["GE1/0/1", "comware.interface"],
      ["DOWN", "common.down"],
    ]);
  });
});

describe("engine", () => {
  it("custom sets replace built-in sets with the same id", () => {
    const custom: HighlightRuleSet[] = [
      {
        id: "cisco",
        name: "Cisco (custom)",
        vendors: ["cisco"],
        rules: [
          {
            id: "my.hostname",
            name: "hostname",
            pattern: "core-sw\\d+",
            caseInsensitive: false,
            fg: "#ff8800",
            bg: null,
            bold: true,
            underline: false,
            enabled: true,
          },
        ],
      },
    ];
    const rules = rulesForVendor("cisco", BUILTIN_RULESETS, custom);
    expect(rules.some((r) => r.id === "cisco.interface")).toBe(false);
    expect(findMatches("core-sw1#", rules)[0]?.ruleId).toBe("my.hostname");
  });

  it("skips disabled, style-less, empty-matching and invalid rules", () => {
    const base = {
      id: "x",
      name: "x",
      caseInsensitive: false,
      fg: "red",
      bg: null,
      bold: false,
      underline: false,
      enabled: true,
    };
    expect(compileRule({ ...base, pattern: "a", enabled: false })).toBeNull();
    expect(compileRule({ ...base, pattern: "a", fg: null })).toBeNull();
    expect(compileRule({ ...base, pattern: "a*" })).toBeNull();
    expect(compileRule({ ...base, pattern: "(" })).toBeNull();
    expect(patternError("(")).toBeTruthy();
    expect(patternError("x?")).toBe("The pattern matches empty text.");
    expect(patternError("Gi\\d+")).toBeNull();
  });

  it("caps work on very long lines", () => {
    const line = "up ".repeat(5000);
    expect(findMatches(line, cisco).length).toBeLessThanOrEqual(64);
  });
});
