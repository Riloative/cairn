import type { SavedConnection, SavedProtocol } from "@/lib/ipc";
import { openRdp } from "@/rdp/controller";
import { buildOptions, EMPTY_FORM, type QuickConnectForm } from "@/ssh/buildOptions";
import { useSavedConnections } from "@/stores/savedConnections";
import { useUi } from "@/stores/ui";
import { openSerial, openSsh, openTelnet } from "@/terminal/controller";
import { buildRdp, EMPTY_RDP, type RdpForm } from "./rdpForm";
import { buildSerial, EMPTY_SERIAL, type SerialForm } from "./serialForm";
import { buildTelnet, EMPTY_TELNET, type TelnetForm } from "./telnetForm";

/** The Quick Connect form of each protocol. */
export interface ConnectForms {
  ssh: QuickConnectForm;
  telnet: TelnetForm;
  serial: SerialForm;
  rdp: RdpForm;
}

export const EMPTY_FORMS: ConnectForms = {
  ssh: EMPTY_FORM,
  telnet: EMPTY_TELNET,
  serial: EMPTY_SERIAL,
  rdp: EMPTY_RDP,
};

/** What is stored for a form: everything except a typed password. */
export function settingsOf<P extends SavedProtocol>(
  protocol: P,
  form: ConnectForms[P],
): Record<string, unknown> {
  const settings: Record<string, unknown> = { ...form };
  if (protocol === "ssh" || protocol === "rdp") delete settings.password;
  return settings;
}

/** A saved connection's form, with defaults for fields added since it was saved. */
export function formOf<P extends SavedProtocol>(protocol: P, settings: Record<string, unknown>) {
  return { ...EMPTY_FORMS[protocol], ...settings, password: "" } as ConnectForms[P];
}

/** A short subtitle: where the connection goes. */
export function targetOf(s: SavedConnection): string {
  const v = s.settings;
  const text = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : "");
  return s.protocol === "serial" ? text("path") : text("destination");
}

/**
 * Open a saved connection in a new tab. The credential profile, if any, is resolved
 * in Rust; without one, the session asks for what it needs.
 */
export function openSaved(s: SavedConnection): boolean {
  const withProfile = s.credentialId !== null;
  const extra = { credentialId: s.credentialId };
  let opened = false;
  switch (s.protocol) {
    case "ssh": {
      const form = formOf("ssh", s.settings);
      const built = buildOptions(form, withProfile);
      if (built) {
        void openSsh(built.options, s.name, { ...extra, vendor: form.vendor });
        opened = true;
      }
      break;
    }
    case "telnet": {
      const form = formOf("telnet", s.settings);
      const built = buildTelnet(form);
      if (built) {
        void openTelnet(built.request, s.name, { ...extra, vendor: form.vendor });
        opened = true;
      }
      break;
    }
    case "serial": {
      const form = formOf("serial", s.settings);
      const built = buildSerial(form);
      if (built) {
        void openSerial(built.options, s.name, { ...extra, vendor: form.vendor });
        opened = true;
      }
      break;
    }
    case "rdp": {
      const built = buildRdp(formOf("rdp", s.settings), withProfile);
      if (built) {
        openRdp(built, s.credentialId);
        opened = true;
      }
      break;
    }
  }
  if (opened) {
    useUi.getState().setView("sessions");
    useSavedConnections.getState().markUsed(s.id);
  } else {
    // Settings that no longer validate: open them in Quick Connect to fix.
    useUi.getState().editSaved(s);
  }
  return opened;
}
