import type { ReactNode } from "react";

/** Tokens worth colouring in network configs: addresses, interfaces, negations. */
const TOKEN =
  /(\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b|\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?:\/\d{1,3})?|\b(?:(?:Gigabit|TenGigabit|TwentyFiveGig|FortyGigabit|Hundred(?:Gig)?)?Ethernet|Gi|Te|Fa|Fo|Hu|Twe|Eth|Po|Port-channel|Vlan|Loopback|Lo|Tunnel|mgmt)\d+(?:\/\d+)*(?:\.\d+)?\b|\b(?:xe|ge|et|ae)-\d+(?:\/\d+)*(?:\.\d+)?|\bno\b|\bshutdown\b)/gi;

function classOf(token: string): string {
  if (/^(no|shutdown)$/i.test(token)) return "text-danger";
  if (/^[\d.]+(\/\d+)?$/.test(token) || token.includes(":")) return "text-accent";
  return "text-warning";
}

/** One configuration line with comments dimmed and key tokens coloured. */
export function highlightLine(text: string): ReactNode {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("!") || trimmed.startsWith("#"))
    return <span className="text-fg-subtle">{text}</span>;
  const parts: ReactNode[] = [];
  let last = 0;
  // A top-level statement's first word reads as a section header.
  const head = !/^\s/.test(text) && /^\S+/.exec(text);
  if (head) {
    parts.push(
      <span key="h" className="font-semibold">
        {head[0]}
      </span>,
    );
    last = head[0].length;
  }
  TOKEN.lastIndex = last;
  for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
    if (m[0] === "") {
      TOKEN.lastIndex += 1;
      continue;
    }
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <span key={m.index} className={classOf(m[0])}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
