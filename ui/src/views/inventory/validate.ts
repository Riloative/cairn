/** Client-side checks for instant feedback; Rust validates again on save. */

export function isIpv4(s: string): boolean {
  const parts = s.split(".");
  return (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255 && (p === "0" || !p.startsWith("0")))
  );
}

export function isIpv6(s: string): boolean {
  if (!s.includes(":") || /[^0-9a-fA-F:.]/.test(s)) return false;
  try {
    return new URL(`http://[${s}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

export function isIp(s: string): boolean {
  const v = s.trim().replace(/^\[|\]$/g, "");
  return isIpv4(v) || isIpv6(v);
}

export function hostnameError(s: string): string | undefined {
  const v = s.trim();
  if (!v) return "Enter a hostname.";
  if (!/^[A-Za-z0-9._-]+$/.test(v)) return "Use letters, digits, '-', '_' and '.' only.";
  if (v.length > 253) return "At most 253 characters.";
  return undefined;
}

/** Parse `1,10-20` into sorted VLAN ids; null when invalid. Mirrors Rust `vlan_list`. */
export function parseVlanList(s: string): number[] | null {
  const out = new Set<number>();
  for (const raw of s.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > 4094 || a > b) return null;
    if (b - a > 4094) return null;
    for (let v = a; v <= b; v++) out.add(v);
  }
  return [...out].sort((x, y) => x - y);
}

/** `[1,10,11,12,99]` → `1,10-12,99`. */
export function formatVlanList(ids: readonly number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < ids.length) {
    const start = ids[i] as number;
    let end = start;
    while (ids[i + 1] === end + 1) {
      end += 1;
      i += 1;
    }
    parts.push(start === end ? String(start) : `${start}-${end}`);
    i += 1;
  }
  return parts.join(",");
}
