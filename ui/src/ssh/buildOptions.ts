import type { AuthMethod, ConnectOptions, Hop, LegacyAlgorithm } from "@/lib/ipc";
import { parseJumps, parseProxy, parseTarget } from "./parse";

export type AuthChoice = "password" | "key" | "agent" | "keyboardInteractive";

export const ALL_LEGACY: LegacyAlgorithm[] = [
  "dh-group1-sha1",
  "dh-group14-sha1",
  "dh-gex-sha1",
  "ssh-rsa-sha1",
  "aes-cbc",
  "triple-des-cbc",
  "hmac-sha1",
];

export const LEGACY_LABELS: Record<LegacyAlgorithm, string> = {
  "dh-group1-sha1": "diffie-hellman-group1-sha1",
  "dh-group14-sha1": "diffie-hellman-group14-sha1",
  "dh-gex-sha1": "diffie-hellman-group-exchange-sha1",
  "ssh-rsa-sha1": "ssh-rsa (SHA-1)",
  "aes-cbc": "aes128/192/256-cbc",
  "triple-des-cbc": "3des-cbc",
  "hmac-sha1": "hmac-sha1",
};

export interface QuickConnectForm {
  destination: string;
  username: string;
  auth: AuthChoice;
  password: string;
  keyPath: string;
  legacy: LegacyAlgorithm[];
  jumps: string;
  proxy: string;
  agentForwarding: boolean;
  keepaliveSecs: number;
}

export const EMPTY_FORM: QuickConnectForm = {
  destination: "",
  username: "",
  auth: "password",
  password: "",
  keyPath: "",
  legacy: [],
  jumps: "",
  proxy: "",
  agentForwarding: false,
  keepaliveSecs: 30,
};

export type FormErrors = Partial<
  Record<"destination" | "username" | "keyPath" | "jumps" | "proxy", string>
>;

/** Auth methods to try, in order: the chosen one, then interactive fallbacks. */
export function authChain(form: QuickConnectForm): AuthMethod[] {
  const prompted: AuthMethod = { kind: "password", password: null };
  switch (form.auth) {
    case "password":
      return [
        { kind: "password", password: form.password ? form.password : null },
        { kind: "keyboardInteractive" },
      ];
    case "key":
      return [
        { kind: "keyFile", path: form.keyPath.trim(), passphrase: null },
        { kind: "keyboardInteractive" },
        prompted,
      ];
    case "agent":
      return [{ kind: "agent" }, { kind: "keyboardInteractive" }, prompted];
    case "keyboardInteractive":
      return [{ kind: "keyboardInteractive" }, prompted];
  }
}

/** Jump hosts never reuse the destination password; they get agent/key + prompts. */
function jumpAuth(form: QuickConnectForm): AuthMethod[] {
  const methods: AuthMethod[] = [{ kind: "agent" }];
  if (form.auth === "key" && form.keyPath.trim())
    methods.push({ kind: "keyFile", path: form.keyPath.trim(), passphrase: null });
  methods.push({ kind: "keyboardInteractive" }, { kind: "password", password: null });
  return methods;
}

export function validate(form: QuickConnectForm): FormErrors {
  const errors: FormErrors = {};
  const target = parseTarget(form.destination);
  if (!target) errors.destination = "Enter a host, e.g. admin@10.0.0.1 or core-sw1:2222.";
  else if (!target.user && !form.username.trim()) errors.username = "Enter a username.";
  if (form.auth === "key" && !form.keyPath.trim()) errors.keyPath = "Choose a private key file.";
  if (form.jumps.trim() && !parseJumps(form.jumps))
    errors.jumps = "Use user@host:port, separated by commas.";
  if (form.proxy.trim() && !parseProxy(form.proxy))
    errors.proxy = "Use socks5://host:port or http://host:port.";
  return errors;
}

/** Build connect options and a tab title; null when the form is invalid. */
export function buildOptions(
  form: QuickConnectForm,
): { options: ConnectOptions; title: string } | null {
  if (Object.keys(validate(form)).length > 0) return null;
  const target = parseTarget(form.destination);
  if (!target) return null;
  const user = target.user ?? form.username.trim();
  const algorithms = { legacy: form.legacy };
  const jumps: Hop[] = (parseJumps(form.jumps) ?? []).map((j) => ({
    host: j.host,
    port: j.port ?? 22,
    username: j.user ?? user,
    auth: jumpAuth(form),
    algorithms,
  }));
  const dest: Hop = {
    host: target.host,
    port: target.port ?? 22,
    username: user,
    auth: authChain(form),
    algorithms,
  };
  return {
    title: target.host,
    options: {
      hops: [...jumps, dest],
      proxy: form.proxy.trim() ? parseProxy(form.proxy) : null,
      keepaliveSecs: form.keepaliveSecs,
      keepaliveMax: 3,
      connectTimeoutSecs: 15,
      agentForwarding: form.agentForwarding,
    },
  };
}
