import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import type { PendingPrompt } from "@/stores/prompts";
import { focusActiveTerminal } from "@/terminal/controller";

type CredentialPending = Extract<PendingPrompt, { type: "prompt" }>;

interface Question {
  label: string;
  echo: boolean;
}

function questions(p: CredentialPending): { title: string; description?: string; qs: Question[] } {
  const prompt = p.prompt;
  switch (prompt.kind) {
    case "password":
      return {
        title: `Password for ${prompt.user}@${prompt.target}`,
        qs: [{ label: "Password", echo: false }],
      };
    case "passphrase":
      return {
        title: "Key passphrase",
        description: `The key ${prompt.key} is encrypted.`,
        qs: [{ label: "Passphrase", echo: false }],
      };
    case "keyboard_interactive":
      return {
        title: prompt.name || `${prompt.user}@${prompt.target}`,
        description: prompt.instructions || undefined,
        qs: prompt.prompts.map((q) => ({ label: q.text.trim() || "Response", echo: q.echo })),
      };
  }
}

/** Password / passphrase / keyboard-interactive (OTP) prompt. Answers go straight to Rust. */
export function CredentialPrompt({
  p,
  onSubmit,
  onCancel,
}: {
  p: CredentialPending;
  onSubmit: (values: string[]) => void;
  onCancel: () => void;
}) {
  const { title, description, qs } = questions(p);
  const [values, setValues] = useState<string[]>(() => qs.map(() => ""));

  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit(values);
    setValues(qs.map(() => ""));
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent title={title} description={description} onClosed={focusActiveTerminal}>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          {qs.map((q, i) => (
            <Field key={i} label={q.label}>
              <Input
                type={q.echo ? "text" : "password"}
                autoFocus={i === 0}
                autoComplete="off"
                spellCheck={false}
                value={values[i] ?? ""}
                onChange={(e) => setValues((v) => v.map((x, j) => (j === i ? e.target.value : x)))}
              />
            </Field>
          ))}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
