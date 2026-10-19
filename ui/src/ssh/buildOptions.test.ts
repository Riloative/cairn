import { describe, expect, it } from "vitest";
import { authChain, buildOptions, EMPTY_FORM, validate } from "./buildOptions";

const form = (patch: Partial<typeof EMPTY_FORM>) => ({ ...EMPTY_FORM, ...patch });

describe("quick connect options", () => {
  it("validates required fields", () => {
    expect(validate(form({}))).toHaveProperty("destination");
    expect(validate(form({ destination: "sw1" }))).toHaveProperty("username");
    expect(validate(form({ destination: "admin@sw1" }))).toEqual({});
    expect(validate(form({ destination: "admin@sw1", auth: "key" }))).toHaveProperty("keyPath");
    expect(validate(form({ destination: "admin@sw1", proxy: "nope" }))).toHaveProperty("proxy");
  });

  it("builds a single hop with interactive fallbacks", () => {
    const r = buildOptions(form({ destination: "admin@10.1.1.1:2222", password: "pw" }));
    expect(r?.title).toBe("10.1.1.1");
    expect(r?.options.hops).toHaveLength(1);
    expect(r?.options.hops[0]).toMatchObject({ host: "10.1.1.1", port: 2222, username: "admin" });
    expect(r?.options.hops[0]?.auth).toEqual([
      { kind: "password", password: "pw" },
      { kind: "keyboardInteractive" },
    ]);
  });

  it("puts jump hosts first, without the destination password", () => {
    const r = buildOptions(
      form({
        destination: "core-sw1",
        username: "netops",
        password: "secret",
        jumps: "jump@bastion:2200",
        legacy: ["dh-group1-sha1"],
      }),
    );
    const hops = r?.options.hops ?? [];
    expect(hops.map((h) => `${h.username}@${h.host}:${h.port}`)).toEqual([
      "jump@bastion:2200",
      "netops@core-sw1:22",
    ]);
    expect(JSON.stringify(hops[0]?.auth)).not.toContain("secret");
    expect(hops[1]?.algorithms.legacy).toEqual(["dh-group1-sha1"]);
  });

  it("asks for the password when none is given", () => {
    expect(authChain(form({ auth: "password" }))[0]).toEqual({ kind: "password", password: null });
    expect(authChain(form({ auth: "agent" })).map((m) => m.kind)).toEqual([
      "agent",
      "keyboardInteractive",
      "password",
    ]);
  });
});
