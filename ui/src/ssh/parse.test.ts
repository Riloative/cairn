import { describe, expect, it } from "vitest";
import { formatTarget, parseJumps, parseProxy, parseTarget } from "./parse";

describe("parseTarget", () => {
  it.each([
    ["sw1", { user: null, host: "sw1", port: null }],
    ["admin@sw1", { user: "admin", host: "sw1", port: null }],
    ["admin@10.0.0.1:2222", { user: "admin", host: "10.0.0.1", port: 2222 }],
    ["[2001:db8::1]:22", { user: null, host: "2001:db8::1", port: 22 }],
    ["ops@[fe80::1]", { user: "ops", host: "fe80::1", port: null }],
    ["2001:db8::5", { user: null, host: "2001:db8::5", port: null }],
    ["user@domain.com@host", { user: "user@domain.com", host: "host", port: null }],
  ])("%s", (input, expected) => {
    expect(parseTarget(input)).toEqual(expected);
  });

  it.each(["", "  ", "host:0", "host:99999", "host:abc", "a b", "@"])("rejects %j", (input) => {
    expect(parseTarget(input)).toBeNull();
  });
});

describe("parseJumps", () => {
  it("parses a chain", () => {
    expect(parseJumps("ops@bastion:2222, core-jump")).toEqual([
      { user: "ops", host: "bastion", port: 2222 },
      { user: null, host: "core-jump", port: null },
    ]);
    expect(parseJumps("")).toEqual([]);
    expect(parseJumps("ok, bad host")).toBeNull();
  });
});

describe("parseProxy", () => {
  it("parses SOCKS5 and HTTP proxies", () => {
    expect(parseProxy("socks5://127.0.0.1:1080")).toEqual({
      kind: "socks5",
      host: "127.0.0.1",
      port: 1080,
      username: null,
      password: null,
    });
    expect(parseProxy("http://alice:p%40ss@proxy.corp:3128")).toEqual({
      kind: "http",
      host: "proxy.corp",
      port: 3128,
      username: "alice",
      password: "p@ss",
    });
  });

  it.each(["", "ftp://x:1", "socks5://host", "http://host:0"])("rejects %j", (input) => {
    expect(parseProxy(input)).toBeNull();
  });
});

describe("formatTarget", () => {
  it("omits the default port and brackets IPv6", () => {
    expect(formatTarget("admin", "sw1", 22)).toBe("admin@sw1");
    expect(formatTarget("admin", "2001:db8::1", 2222)).toBe("admin@[2001:db8::1]:2222");
  });
});
