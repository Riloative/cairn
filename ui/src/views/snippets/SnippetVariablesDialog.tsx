import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import type { Snippet } from "@/lib/ipc";
import { renderSnippet, snippetPath } from "@/lib/snippets";
import { useSnippets } from "@/stores/snippets";
import { focusActiveTerminal } from "@/terminal/controller";
import { typeIntoTab } from "@/terminal/snippetRun";

function VariablesForm({ snippet, tabId }: { snippet: Snippet; tabId: string }) {
  const close = () => useSnippets.getState().setPending(null);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(snippet.variables.map((v) => [v.name, v.default])),
  );
  const preview = renderSnippet(snippet.body, values);

  function submit(e: FormEvent) {
    e.preventDefault();
    close();
    void typeIntoTab(tabId, preview);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent
        title={snippetPath(snippet)}
        description="Fill in the variables. The last line is typed without Enter so you can review it."
        onClosed={focusActiveTerminal}
      >
        <form className="flex flex-col gap-4" onSubmit={submit}>
          {snippet.variables.map((v, i) => (
            <Field key={v.name} label={v.name}>
              <Input
                autoFocus={i === 0}
                spellCheck={false}
                value={values[v.name] ?? ""}
                onChange={(e) => setValues({ ...values, [v.name]: e.target.value })}
              />
            </Field>
          ))}
          <pre
            aria-label="Preview"
            className="max-h-40 overflow-auto rounded-md border border-border bg-surface-raised p-2.5 font-mono text-xs whitespace-pre-wrap"
          >
            {preview}
          </pre>
          <DialogFooter className="mt-0">
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Insert
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Asks for a snippet's variables before typing it into the terminal. */
export function SnippetVariablesDialog() {
  const pending = useSnippets((s) => s.pending);
  if (!pending) return null;
  return (
    <VariablesForm
      key={`${pending.snippet.id}:${pending.tabId}`}
      snippet={pending.snippet}
      tabId={pending.tabId}
    />
  );
}
