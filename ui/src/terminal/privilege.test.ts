import { describe, expect, it } from "vitest";
import { DEFAULT_PRIVILEGED_PATTERNS } from "@/stores/terminalPrefs";
import { compilePatterns, isPrivilegedPrompt } from "./privilege";

const patterns = compilePatterns(DEFAULT_PRIVILEGED_PATTERNS);

describe("privileged prompt detection", () => {
  it.each([
    "core-sw1#",
    "core-sw1# ",
    "core-sw1(config)#",
    "core-sw1(config-if)#",
    "SW-ACCESS-01#",
    "aruba-6300#",
    "HP-2530-48G#",
    "root@srx1%",
    "root@srx1#",
    "root@web01:~#",
    "root@web01:/etc/nginx# ",
    "[root@db01 ~]#",
    "[HP-5130]",
    "[HP-5130-GigabitEthernet1/0/1]",
  ])("flags %j", (prompt) => {
    expect(isPrivilegedPrompt(prompt, patterns)).toBe(true);
  });

  it.each([
    "core-sw1>",
    "admin@srx1>",
    "user@web01:~$",
    "[user@db01 ~]$",
    "<HP-5130>",
    "",
    "show running-config | include #",
    "# this is a comment line typed by the user",
  ])("does not flag %j", (prompt) => {
    expect(isPrivilegedPrompt(prompt, patterns)).toBe(false);
  });

  it("skips invalid user patterns", () => {
    expect(compilePatterns(["(", "^x#$"])).toHaveLength(1);
  });
});
