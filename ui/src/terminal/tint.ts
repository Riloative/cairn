import type { SessionTab } from "@/stores/sessions";

export type HeaderTint = "local" | "remote" | "serial" | "privileged";

export function headerTint(tab: SessionTab, privileged: boolean): HeaderTint {
  if (privileged) return "privileged";
  if (tab.protocol === "serial") return "serial";
  if (tab.protocol === "ssh" || tab.protocol === "telnet") return "remote";
  return "local";
}
