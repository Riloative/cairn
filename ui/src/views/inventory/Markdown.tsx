import { openUrl } from "@tauri-apps/plugin-opener";
import type { ReactNode } from "react";
import { useNotifications } from "@/stores/notifications";

/**
 * Minimal Markdown for device notes: headings, lists, paragraphs, `code`, **bold**,
 * *italic* and [links](https://…). Built from React elements only (never HTML), and
 * links open in the browser on explicit click.
 */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        code.push(lines[i] ?? "");
        i += 1;
      }
      i += 1;
      blocks.push(
        <pre
          key={key++}
          className="overflow-x-auto rounded-md bg-surface-raised p-2 font-mono text-xs"
        >
          {code.join("\n")}
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const cls = level === 1 ? "text-[15px] font-semibold" : "text-[13px] font-semibold";
      blocks.push(
        <p key={key++} role="heading" aria-level={level + 2} className={cls}>
          {inline(heading[2] ?? "")}
        </p>,
      );
      i += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      blocks.push(
        <ul key={key++} className="list-disc pl-5">
          {items.map((t, j) => (
            <li key={j}>{inline(t)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() &&
      !/^(#{1,3}\s|```|\s*[-*]\s)/.test(lines[i] ?? "")
    ) {
      para.push(lines[i] ?? "");
      i += 1;
    }
    blocks.push(<p key={key++}>{inline(para.join(" "))}</p>);
  }
  return <div className="flex flex-col gap-2 text-[13px] leading-relaxed">{blocks}</div>;
}

function openLink(url: string) {
  openUrl(url).catch((e: unknown) =>
    useNotifications.getState().notifyError(e, "Could not open the link"),
  );
}

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1)
      return (
        <code key={i} className="rounded bg-surface-raised px-1 font-mono text-xs">
          {part.slice(1, -1)}
        </code>
      );
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2)
      return <em key={i}>{part.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part);
    if (link) {
      const url = link[2] ?? "";
      return (
        <button
          key={i}
          type="button"
          title={url}
          className="text-accent underline-offset-2 hover:underline"
          onClick={() => openLink(url)}
        >
          {link[1]}
        </button>
      );
    }
    return part;
  });
}
