import type { RdpOptions } from "@/lib/ipc";
import type { RdpSettings } from "@/rdp/RdpSettingsFields";
import { parseTarget } from "@/ssh/parse";

export interface RdpForm extends RdpSettings {
  /** `host`, `host:port` or `user@host:port`. */
  destination: string;
  username: string;
  /** Typed only for this connection; never stored. Empty asks when connecting. */
  password: string;
}

export const EMPTY_RDP: RdpForm = {
  destination: "",
  username: "",
  password: "",
  domain: "",
  security: "nla",
  width: 0,
  height: 0,
  colorDepth: 32,
  clipboard: true,
  tunnel: "",
};

export type RdpErrors = Partial<Record<"destination" | "username", string>>;

/** `userFromProfile`: a credential profile supplies the username when it is empty. */
export function validateRdp(form: RdpForm, userFromProfile = false): RdpErrors {
  const errors: RdpErrors = {};
  const target = parseTarget(form.destination);
  if (!target) errors.destination = "Enter a host or host:port.";
  if (!(target?.user ?? form.username).trim() && !userFromProfile)
    errors.username = "Enter a username.";
  return errors;
}

export function buildRdp(form: RdpForm, userFromProfile = false): RdpOptions | null {
  const target = parseTarget(form.destination);
  if (!target || Object.keys(validateRdp(form, userFromProfile)).length > 0) return null;
  return {
    host: target.host,
    port: target.port ?? 3389,
    username: (target.user ?? form.username).trim(),
    password: form.password || null,
    domain: form.domain.trim(),
    security: form.security,
    width: form.width,
    height: form.height,
    colorDepth: form.colorDepth,
    clipboard: form.clipboard,
    tunnel: form.tunnel.trim(),
  };
}
