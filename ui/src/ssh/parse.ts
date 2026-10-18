import type { ProxyConfig } from "@/lib/ipc";

export interface ParsedTarget {
  user: string | null;
  host: string;
  port: number | null;
}

/**
 * Parse `user@host:port`, `host`, `[v6::addr]:port` or a bare IPv6 address.
 * Returns null for empty or malformed input.
 */
export function parseTarget(input: string): ParsedTarget | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  const at = text.lastIndexOf("@");
  const user = at > 0 ? text.slice(0, at) : null;
  const rest = at >= 0 ? text.slice(at + 1) : text;
  if (!rest) return null;

  let host = rest;
  let port: number | null = null;
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
  if (bracket) {
    host = bracket[1] ?? "";
    port = bracket[2] ? Number(bracket[2]) : null;
  } else if ((rest.match(/:/g) ?? []).length === 1) {
    const [h, p] = rest.split(":");
    if (!h || !p || !/^\d+$/.test(p)) return null;
    host = h;
    port = Number(p);
  }
  if (port !== null && (port < 1 || port > 65535)) return null;
  if (!host) return null;
  return { user, host, port };
}

/** Comma-separated jump hosts (`user@bastion:22, core-jump`). */
export function parseJumps(input: string): ParsedTarget[] | null {
  const parts = input
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const out: ParsedTarget[] = [];
  for (const p of parts) {
    const t = parseTarget(p);
    if (!t) return null;
    out.push(t);
  }
  return out;
}

/** `socks5://[user:pass@]host:port` or `http://[user:pass@]host:port`. */
export function parseProxy(input: string): ProxyConfig | null {
  const m = /^(socks5|http):\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^:/\s]+|\[[^\]]+\]):(\d+)\/?$/i.exec(
    input.trim(),
  );
  if (!m) return null;
  const port = Number(m[5]);
  if (port < 1 || port > 65535) return null;
  return {
    kind: (m[1] ?? "").toLowerCase() as "socks5" | "http",
    host: (m[4] ?? "").replace(/^\[|\]$/g, ""),
    port,
    username: m[2] ? decodeURIComponent(m[2]) : null,
    password: m[3] ? decodeURIComponent(m[3]) : null,
  };
}

export function formatTarget(user: string, host: string, port: number): string {
  const h = host.includes(":") ? `[${host}]` : host;
  return `${user}@${h}${port === 22 ? "" : `:${port}`}`;
}
