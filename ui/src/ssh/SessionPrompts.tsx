import { useNotifications } from "@/stores/notifications";
import { usePrompts } from "@/stores/prompts";
import { CredentialPrompt } from "./CredentialPrompt";
import { HostKeyPrompt } from "./HostKeyPrompt";

/** Shows the oldest pending session prompt (host key or credentials). */
export function SessionPrompts() {
  const current = usePrompts((s) => s.queue[0]);
  const answer = usePrompts((s) => s.answer);
  const notifyError = useNotifications((s) => s.notifyError);
  if (!current) return null;

  const reply = (a: Parameters<typeof answer>[1]) =>
    answer(current.id, a).catch((e: unknown) => notifyError(e, "Could not send the answer"));

  if (current.type === "host_key") {
    return (
      <HostKeyPrompt
        key={current.id}
        p={current}
        onAnswer={(accept) => void reply({ kind: "hostKey", accept })}
      />
    );
  }
  return (
    <CredentialPrompt
      key={current.id}
      p={current}
      onSubmit={(values) => void reply({ kind: "secrets", values })}
      onCancel={() => void reply({ kind: "cancel" })}
    />
  );
}
