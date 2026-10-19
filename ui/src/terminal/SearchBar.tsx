import type { ISearchOptions } from "@xterm/addon-search";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { useTerminalUi } from "@/stores/terminalUi";
import { getTerminal } from "./registry";

/** Search decoration colors (xterm only accepts #RRGGBB). */
const DECORATIONS: NonNullable<ISearchOptions["decorations"]> = {
  matchBackground: "#5c4a00",
  matchBorder: "#a68a00",
  matchOverviewRuler: "#a68a00",
  activeMatchBackground: "#b8860b",
  activeMatchBorder: "#ffd75e",
  activeMatchColorOverviewRuler: "#ffd75e",
};

function Toggle({
  label,
  title,
  on,
  onChange,
}: {
  label: string;
  title: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className={cn(
        "h-6 min-w-6 rounded px-1 font-mono text-[11px] text-fg-muted hover:text-fg",
        on && "bg-accent-subtle text-fg",
      )}
    >
      {label}
    </button>
  );
}

/** In-scrollback search for the active terminal (regex / case / whole word). */
export function SearchBar({ tabId }: { tabId: string }) {
  const open = useTerminalUi((s) => s.searchOpen);
  const setOpen = useTerminalUi((s) => s.setSearchOpen);
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [results, setResults] = useState<{ index: number; count: number } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const handle = getTerminal(tabId);

  useEffect(() => {
    if (!handle) return;
    const sub = handle.search.onDidChangeResults(({ resultIndex, resultCount }) =>
      setResults({ index: resultIndex, count: resultCount }),
    );
    return () => sub.dispose();
  }, [handle]);

  useEffect(() => {
    if (open) inputRef.current?.select();
  }, [open]);

  if (!open || !handle) return null;

  const options: ISearchOptions = { regex, caseSensitive, wholeWord, decorations: DECORATIONS };

  function find(direction: "next" | "previous", incremental = false, q = query) {
    if (!handle) return;
    if (!q) {
      handle.search.clearDecorations();
      setResults(null);
      return;
    }
    if (regex) {
      try {
        new RegExp(q);
      } catch {
        setInvalid(true);
        return;
      }
    }
    setInvalid(false);
    if (direction === "next") handle.search.findNext(q, { ...options, incremental });
    else handle.search.findPrevious(q, options);
  }

  function close() {
    handle?.search.clearDecorations();
    setOpen(false);
    handle?.term.focus();
  }

  return (
    <div
      role="search"
      className="absolute top-2 right-4 z-10 flex items-center gap-1 rounded-lg border border-border bg-surface-raised p-1 shadow-md animate-pop-in"
    >
      <input
        ref={inputRef}
        aria-label="Search scrollback"
        placeholder="Find"
        spellCheck={false}
        value={query}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          setQuery(e.target.value);
          find("next", true, e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") find(e.shiftKey ? "previous" : "next");
          if (e.key === "Escape") close();
        }}
        className={cn(
          "h-6 w-48 rounded bg-surface px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
          invalid && "text-danger",
        )}
      />
      <span className="w-16 text-center text-[11px] text-fg-subtle tabular-nums">
        {invalid
          ? "bad regex"
          : results
            ? results.count === 0
              ? "no results"
              : `${results.index + 1} of ${results.count}`
            : ""}
      </span>
      <Toggle label="Aa" title="Match case" on={caseSensitive} onChange={setCaseSensitive} />
      <Toggle label="W" title="Whole word" on={wholeWord} onChange={setWholeWord} />
      <Toggle label=".*" title="Regular expression" on={regex} onChange={setRegex} />
      <button
        type="button"
        aria-label="Previous match"
        onClick={() => find("previous")}
        className="rounded p-1 text-fg-muted hover:text-fg"
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        aria-label="Next match"
        onClick={() => find("next")}
        className="rounded p-1 text-fg-muted hover:text-fg"
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        aria-label="Close search"
        onClick={close}
        className="rounded p-1 text-fg-muted hover:text-fg"
      >
        <X size={14} />
      </button>
    </div>
  );
}
