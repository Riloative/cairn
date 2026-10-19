import { describe, expect, it } from "vitest";
import type { Snippet } from "./ipc";
import { groupByFolder, renderSnippet, snippetLines, snippetPath, snippetsFor } from "./snippets";

const s = (over: Partial<Snippet>): Snippet => ({
  id: 1,
  name: "x",
  folder: "",
  vendor: "",
  body: "",
  description: "",
  variables: [],
  ...over,
});

describe("snippets", () => {
  it("renders values and defaults like the Rust side", () => {
    expect(
      renderSnippet("int {{ iface }}\n desc {{desc:uplink}}\n vlan {{vlan:1}}", {
        iface: "Gi1/0/1",
        vlan: "20",
      }),
    ).toBe("int Gi1/0/1\n desc uplink\n vlan 20");
    expect(renderSnippet("no vars { }", {})).toBe("no vars { }");
  });

  it("filters by vendor case-insensitively and keeps generic snippets", () => {
    const list = [
      s({ id: 1, vendor: "Cisco" }),
      s({ id: 2, vendor: "" }),
      s({ id: 3, vendor: "Juniper" }),
    ];
    expect(snippetsFor(list, "cisco").map((x) => x.id)).toEqual([1, 2]);
    expect(snippetsFor(list, undefined).map((x) => x.id)).toEqual([2]);
  });

  it("types lines with Enter except the last", () => {
    expect(snippetLines("conf t\r\nint gi1\nend\n")).toEqual(["conf t\r", "int gi1\r", "end"]);
    expect(snippetLines("show ver")).toEqual(["show ver"]);
  });

  it("groups by folder and builds paths", () => {
    const list = [s({ id: 1, folder: "b" }), s({ id: 2, folder: "" }), s({ id: 3, folder: "b" })];
    expect(groupByFolder(list).map(([f, items]) => [f, items.length])).toEqual([
      ["", 1],
      ["b", 2],
    ]);
    expect(snippetPath(s({ folder: "Cisco/Int", name: "Desc" }))).toBe("Cisco/Int/Desc");
  });
});
