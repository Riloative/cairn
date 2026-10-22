import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The IPC surface has three copies that must agree: the commands registered in
 * `src-tauri/src/lib.rs`, the typed wrappers in `ui/src/lib/ipc.ts`, and the cases the
 * test fakes answer. Paths are taken from this file's location, not the cwd.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const read = (rel: string) => readFileSync(resolve(repo, rel), "utf8");

/** Commands no fake handles: session plumbing exercised by the UI smoke and e2e runs. */
const SMOKE_ONLY = new Set([
  "ssh_open",
  "ssh_reconnect",
  "ssh_forget",
  "telnet_open",
  "serial_open",
  "session_open_local",
  "session_write",
  "session_resize",
  "session_close",
  "local_default_shell",
  "device_connect",
  "known_hosts_remove",
  "ui_log_error",
]);

/** `commands::ssh::ssh_open` entries inside `tauri::generate_handler![ ... ]`. */
function rustCommands(): string[] {
  const src = read("src-tauri/src/lib.rs");
  const block = /generate_handler!\[([\s\S]*?)\]/.exec(src)?.[1];
  if (!block) throw new Error("generate_handler![…] not found in src-tauri/src/lib.rs");
  return [...block.matchAll(/commands::\w+::(\w+)/g)].map((m) => m[1] as string);
}

/** Command-name literals passed to `call<T>("…")` or `invoke("…")` in ipc.ts. */
function ipcCommands(): string[] {
  const src = read("ui/src/lib/ipc.ts");
  return [...src.matchAll(/\b(?:call(?:<[^>]*>)?|invoke(?:<[^>]*>)?)\(\s*"([a-z_]+)"/g)].map(
    (m) => m[1] as string,
  );
}

/** `case "name":` labels in the fakes (prefix dispatch in FakeBackend lands in the others). */
function fakeCases(): Set<string> {
  const files = ["fakeBackend.ts", "fakeInventory.ts", "fakeMap.ts"];
  const names = new Set<string>();
  for (const f of files) {
    for (const m of read(`ui/src/test/${f}`).matchAll(/case "([a-z_]+)":/g)) {
      names.add(m[1] as string);
    }
  }
  return names;
}

const sorted = (xs: Iterable<string>) => [...xs].sort();
const diff = (a: Iterable<string>, b: Set<string>) => sorted([...a].filter((x) => !b.has(x)));

describe("IPC parity", () => {
  const rust = rustCommands();
  const ipc = ipcCommands();
  const fakes = fakeCases();

  it("registers each Rust command once", () => {
    expect(rust.length).toBeGreaterThan(100);
    expect(sorted(new Set(rust))).toEqual(sorted(rust));
  });

  it("ipc.ts wraps exactly the registered commands", () => {
    const rustSet = new Set(rust);
    const ipcSet = new Set(ipc);
    expect({
      "registered in lib.rs but not wrapped in ipc.ts": diff(rustSet, ipcSet),
      "wrapped in ipc.ts but not registered in lib.rs": diff(ipcSet, rustSet),
    }).toEqual({
      "registered in lib.rs but not wrapped in ipc.ts": [],
      "wrapped in ipc.ts but not registered in lib.rs": [],
    });
  });

  it("every wrapped command is answered by a fake, or is on the smoke-only list", () => {
    const unhandled = diff(new Set(ipc), new Set([...fakes, ...SMOKE_ONLY]));
    expect({ "wrapped in ipc.ts but no fake handles it": unhandled }).toEqual({
      "wrapped in ipc.ts but no fake handles it": [],
    });
  });

  it("the smoke-only list names only real, unfaked commands", () => {
    const rustSet = new Set(rust);
    expect({
      "smoke-only but not registered": diff(SMOKE_ONLY, rustSet),
      "smoke-only but a fake handles it (drop from the list)": sorted(
        [...SMOKE_ONLY].filter((c) => fakes.has(c)),
      ),
    }).toEqual({
      "smoke-only but not registered": [],
      "smoke-only but a fake handles it (drop from the list)": [],
    });
  });
});
