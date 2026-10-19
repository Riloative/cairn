#!/usr/bin/env node
// End-to-end smoke test of a release build through tauri-driver (WebDriver): first-run
// setup and the backup offer, adding a device, the audit log and its integrity check,
// the shortcuts sheet, lock and unlock. Saves a screenshot of each step.
//
// Usage: node e2e/smoke.mjs <path-to-cairn-binary> <output-dir>
// Needs tauri-driver on PATH (cargo install tauri-driver) and, on Linux,
// WebKitWebDriver (apt install webkit2gtk-driver) and a display (Xvfb).

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Driver } from "./webdriver.mjs";

const [binArg, outArg] = process.argv.slice(2);
if (!binArg || !outArg) {
  console.error("usage: node e2e/smoke.mjs <cairn binary> <output dir>");
  process.exit(2);
}
const bin = resolve(binArg);
const out = resolve(outArg);
mkdirSync(out, { recursive: true });

const MASTER = "glacier-tandem-orbit-velvet";
const data = mkdtempSync(join(tmpdir(), "cairn-e2e-"));
const driverProc = spawn("tauri-driver", [], {
  env: { ...process.env, XDG_DATA_HOME: data, WEBKIT_DISABLE_DMABUF_RENDERER: "1" },
  stdio: ["ignore", "inherit", "inherit"],
});

const d = new Driver();
let step = 0;
async function shot(name) {
  step += 1;
  const file = join(out, `${String(step).padStart(2, "0")}-${name}.png`);
  writeFileSync(file, Buffer.from(await d.screenshot(), "base64"));
  console.log(`✓ ${name}`);
}

/** The input labelled `label` (labels are associated with their inputs). */
async function byLabel(label) {
  return d.until(`field "${label}"`, async () => {
    const el = await d.run(
      `const l = [...document.querySelectorAll("label")].find((x) => x.textContent.trim() === arguments[0]);
       return l ? document.getElementById(l.htmlFor) : null;`,
      label,
    );
    return el ? Object.values(el)[0] : null;
  });
}

async function nav(section) {
  await d.click(await d.findText('nav[aria-label="Sections"] button', section));
}

try {
  await d.until("tauri-driver", () =>
    fetch("http://127.0.0.1:4444/status")
      .then((r) => r.ok)
      .catch(() => false),
  );
  await d.start(bin);

  // First run: master password, the no-recovery acknowledgment, then the backup offer.
  await d.findText("h1", "Create a master password", 20_000);
  await shot("setup");
  await d.type(await byLabel("Master password"), MASTER);
  await d.type(await byLabel("Confirm password"), MASTER);
  await d.click(await d.find('input[type="checkbox"]'));
  await d.click(await d.findText("button", "Create vault"));
  await d.findText('[role="dialog"] h2', "Create a backup", 30_000);
  await shot("backup-offer");
  await d.click(await d.findText('[role="dialog"] button', "Cancel"));
  await d.findText("h2", "No open sessions");
  await shot("sessions-get-started");

  // Inventory: add a device and see it in the table.
  await nav("Inventory");
  await d.click(await d.findText("button", "Add a device"));
  await d.type(await byLabel("Hostname"), "e2e-core-sw1");
  await d.type(await byLabel("Management IP"), "10.99.0.1");
  await d.click(await d.findText('button[type="submit"]', "Add device"));
  await d.findText("table td, [role='row'] *", "e2e-core-sw1");
  await shot("inventory");
  // The new device's sheet stays open; close it.
  await d.click(await d.find('[role="dialog"] button[aria-label="Close"]'));

  // Audit: the change is logged and the chain verifies.
  await nav("Audit");
  await d.findText("td", "Inventory changed");
  await d.click(await d.findText("button", "Verify integrity"));
  await d.findText("body *", "Chain intact");
  await shot("audit");

  // Shortcuts sheet from the palette.
  await d.run(
    `window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", ctrlKey: true, metaKey: navigator.platform.includes("Mac") }))`,
  );
  await d.findText('[role="dialog"] h2', "Keyboard shortcuts");
  await shot("shortcuts");
  await d.click(await d.find('[role="dialog"] button[aria-label="Close"]'));

  // Lock and unlock.
  await d.click(await d.find('button[aria-label="Lock"]'));
  await d.findText("h1", "Welcome back");
  await shot("locked");
  await d.type(await byLabel("Master password"), MASTER);
  await d.click(await d.findText("button", "Unlock"));
  await d.find('nav[aria-label="Sections"]', 20_000);
  await shot("unlocked");
  console.log("e2e smoke passed");
} catch (e) {
  console.error(`e2e smoke failed: ${e.message}`);
  try {
    await shot("failure");
  } catch {
    // The window may already be gone.
  }
  process.exitCode = 1;
} finally {
  await d.quit();
  driverProc.kill();
  // The app and WebKit may still be writing to the data directory while they exit;
  // wait for the driver to go, retry the removal, and never fail the run over it.
  await new Promise((done) => {
    if (driverProc.exitCode !== null || driverProc.signalCode !== null) done();
    else driverProc.once("exit", done);
  });
  try {
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    console.warn(`could not remove ${data}: ${e.message}`);
  }
}
