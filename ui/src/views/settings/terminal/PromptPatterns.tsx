import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { DEFAULT_PRIVILEGED_PATTERNS } from "@/stores/terminalPrefs";
import { patternError } from "@/terminal/highlight/engine";

/** One regex per line; matched against the text left of the cursor. */
export function PromptPatterns({
  patterns,
  onSave,
}: {
  patterns: string[];
  onSave: (patterns: string[]) => Promise<void>;
}) {
  const [text, setText] = useState(patterns.join("\n"));
  const lines = text.split("\n").filter((l) => l.trim());
  const errors = lines
    .map((l, i) => ({ line: i + 1, error: patternError(l) }))
    .filter((e) => e.error);
  const dirty = lines.join("\n") !== patterns.join("\n");

  return (
    <div className="flex flex-col gap-2 py-4">
      <p className="font-medium">Privileged prompts</p>
      <p className="text-xs text-fg-muted">
        Regular expressions, one per line, tested against the text left of the cursor. A match turns
        the session header red (e.g. <code className="font-mono">core-sw1#</code>,{" "}
        <code className="font-mono">root@host:~#</code>).
      </p>
      <textarea
        aria-label="Privileged prompt patterns"
        spellCheck={false}
        rows={6}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="rounded-md border border-border bg-surface p-2 font-mono text-xs"
      />
      {errors.length > 0 && (
        <p role="alert" className="text-xs text-danger">
          Line {errors[0]?.line}: {errors[0]?.error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setText(DEFAULT_PRIVILEGED_PATTERNS.join("\n"))}>
          Reset to defaults
        </Button>
        <Button
          variant="primary"
          disabled={!dirty || errors.length > 0}
          onClick={() => void onSave(lines)}
        >
          Save patterns
        </Button>
      </div>
    </div>
  );
}
