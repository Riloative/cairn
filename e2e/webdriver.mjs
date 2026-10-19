// A minimal W3C WebDriver client (Node's fetch, no dependencies) for driving the Tauri
// app through tauri-driver. Only what the smoke test needs.

const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

export class Driver {
  constructor(base = "http://127.0.0.1:4444") {
    this.base = base;
    this.session = null;
  }

  async cmd(method, path, body) {
    const url = `${this.base}${this.session ? `/session/${this.session}` : ""}${path}`;
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const v = json.value ?? {};
      throw new Error(`${method} ${path}: ${v.error ?? res.status} ${v.message ?? ""}`.trim());
    }
    return json.value;
  }

  async start(application) {
    const value = await this.cmd("POST", "/session", {
      capabilities: { alwaysMatch: { "tauri:options": { application } } },
    });
    this.session = value.sessionId;
  }

  async quit() {
    if (!this.session) return;
    await this.cmd("DELETE", "").catch(() => {});
    this.session = null;
  }

  /** Wait until `fn` returns a truthy value (or throw after `timeout` ms). */
  async until(what, fn, timeout = 10_000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      try {
        const v = await fn();
        if (v) return v;
      } catch (e) {
        last = e;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
  }

  async find(css, timeout) {
    return this.until(
      `"${css}"`,
      async () => {
        const els = await this.cmd("POST", "/elements", { using: "css selector", value: css });
        return els.length ? els[0][ELEMENT] : null;
      },
      timeout,
    );
  }

  /**
   * The first visible element matching `css` whose text contains `text`. Matches on
   * textContent in the page: WebKitWebDriver's element text is empty for some
   * elements it considers hidden (e.g. buttons wrapped in tooltip triggers).
   */
  async findText(css, text, timeout) {
    return this.until(
      `"${text}" in ${css}`,
      async () => {
        const el = await this.run(
          `return [...document.querySelectorAll(arguments[0])].find(
           (e) => e.textContent.includes(arguments[1]) && e.getClientRects().length > 0,
         ) ?? null;`,
          css,
          text,
        );
        return el ? el[ELEMENT] : null;
      },
      timeout,
    );
  }

  async click(id) {
    await this.cmd("POST", `/element/${id}/click`, {});
  }

  async type(id, text) {
    await this.cmd("POST", `/element/${id}/value`, { text });
  }

  async text(id) {
    return this.cmd("GET", `/element/${id}/text`);
  }

  async run(script, ...args) {
    return this.cmd("POST", "/execute/sync", { script, args });
  }

  /** Base64 PNG of the window. */
  async screenshot() {
    return this.cmd("GET", "/screenshot");
  }
}
