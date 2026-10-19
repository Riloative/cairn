import { Bookmark } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { NativeSelect } from "@/components/ui/NativeSelect";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { RdpFields } from "@/connect/RdpFields";
import { buildRdp, EMPTY_RDP, validateRdp, type RdpForm } from "@/connect/rdpForm";
import { formOf, settingsOf } from "@/connect/saved";
import { SerialFields } from "@/connect/SerialFields";
import { buildSerial, EMPTY_SERIAL, validateSerial, type SerialForm } from "@/connect/serialForm";
import { TelnetFields } from "@/connect/TelnetFields";
import { buildTelnet, EMPTY_TELNET, validateTelnet, type TelnetForm } from "@/connect/telnetForm";
import type { SavedConnection } from "@/lib/ipc";
import { openRdp } from "@/rdp/controller";
import { useInventory } from "@/stores/inventory";
import { useNotifications } from "@/stores/notifications";
import { useSavedConnections } from "@/stores/savedConnections";
import { useUi, type ConnectProtocol } from "@/stores/ui";
import { focusActiveTerminal, openSerial, openSsh, openTelnet } from "@/terminal/controller";
import { parseTarget } from "./parse";
import { buildOptions, EMPTY_FORM, validate, type QuickConnectForm } from "./buildOptions";
import { SshFields } from "./SshFields";

function useForm<T extends object>(initial: T) {
  const [form, setForm] = useState<T>(initial);
  const set = useCallback(
    <K extends keyof T>(k: K, v: T[K]) => setForm((f) => ({ ...f, [k]: v })),
    [],
  );
  return [form, set, setForm] as const;
}

const DESCRIPTIONS: Record<ConnectProtocol, string> = {
  ssh: "Connect by address. Saved devices connect from the inventory or the palette.",
  telnet: "Telnet or raw TCP, including console-server ports (reverse Telnet).",
  serial: "A console cable on this machine. The port list follows plugging and unplugging.",
  rdp: "A Windows or xrdp desktop. The server's certificate is checked before you sign in.",
};

/** A suggested name for a new saved connection: the host, or the serial port. */
function suggestName(destination: string): string {
  return parseTarget(destination)?.host ?? destination.trim();
}

/** Quick-connect dialog with SSH, Telnet, Serial and RDP tabs (`Mod+N`). */
export function QuickConnectDialog() {
  const open = useUi((s) => s.quickConnectOpen);
  const setOpen = useUi((s) => s.setQuickConnectOpen);
  const protocol = useUi((s) => s.connectProtocol);
  const setProtocol = useUi((s) => s.setConnectProtocol);
  const setView = useUi((s) => s.setView);
  const editing = useUi((s) => s.editingSaved);
  const credentials = useInventory((s) => s.snapshot?.credentials) ?? [];
  const saveConnection = useSavedConnections((s) => s.save);
  const markUsed = useSavedConnections((s) => s.markUsed);
  const notify = useNotifications((s) => s.notify);
  const [ssh, setSsh, replaceSsh] = useForm<QuickConnectForm>(EMPTY_FORM);
  const [telnet, setTelnet, replaceTelnet] = useForm<TelnetForm>(EMPTY_TELNET);
  const [serial, setSerial, replaceSerial] = useForm<SerialForm>(EMPTY_SERIAL);
  const [rdp, setRdp] = useState<RdpForm>(EMPTY_RDP);
  const [touched, setTouched] = useState(false);
  // Focus the first field when the dialog opens, but not when switching tabs (keyboard
  // users stay on the tab list).
  const [focusFields, setFocusFields] = useState(true);
  // Saving: shown on "Save…", or right away when a saved connection is loaded.
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [credentialId, setCredentialId] = useState<number | null>(null);
  const withProfile = credentialId !== null;

  // Fill the dialog from a saved connection when one is loaded (state adjusted during
  // render, React's pattern for state derived from a changed prop).
  const [loaded, setLoaded] = useState<SavedConnection | null>(null);
  if (open && editing && editing !== loaded) {
    setLoaded(editing);
    switch (editing.protocol) {
      case "ssh":
        replaceSsh(formOf("ssh", editing.settings));
        break;
      case "telnet":
        replaceTelnet(formOf("telnet", editing.settings));
        break;
      case "serial":
        replaceSerial(formOf("serial", editing.settings));
        break;
      case "rdp":
        setRdp(formOf("rdp", editing.settings));
        break;
    }
    setSaving(true);
    setName(editing.name);
    setCredentialId(editing.credentialId);
    setTouched(true);
  }

  function close() {
    setOpen(false);
    // Never keep a typed password around after the dialog closes.
    replaceSsh((f) => ({ ...f, password: "" }));
    setRdp((f) => ({ ...f, password: "" }));
    setTouched(false);
    setFocusFields(true);
    setSaving(false);
    setName("");
    setNameError(null);
    setCredentialId(null);
    setLoaded(null);
  }

  /** The current tab's form, if it is valid. */
  function valid(): boolean {
    switch (protocol) {
      case "ssh":
        return Object.keys(validate(ssh, withProfile)).length === 0;
      case "telnet":
        return Object.keys(validateTelnet(telnet)).length === 0;
      case "serial":
        return Object.keys(validateSerial(serial)).length === 0;
      case "rdp":
        return Object.keys(validateRdp(rdp, withProfile)).length === 0;
    }
  }

  function startSaving() {
    setSaving(true);
    if (!name)
      setName(
        suggestName(
          protocol === "serial" ? serial.path : { ssh, telnet, rdp }[protocol].destination,
        ),
      );
  }

  async function save() {
    setTouched(true);
    if (!name.trim()) {
      setNameError("Enter a name.");
      return;
    }
    setNameError(null);
    if (!valid()) return;
    const form = { ssh, telnet, serial, rdp }[protocol];
    const saved = await saveConnection({
      id: editing?.protocol === protocol ? editing.id : 0,
      name: name.trim(),
      protocol,
      settings: settingsOf(protocol, form),
      credentialId,
      lastUsedAt: null,
    });
    if (!saved) return;
    notify({
      variant: "success",
      title: editing ? `Updated ${saved.name}` : `Saved ${saved.name}`,
      description: "Open it from Saved in the sidebar or the command palette.",
    });
    close();
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    const extra = credentialId === null ? {} : { credentialId };
    const usedId = editing?.protocol === protocol ? editing.id : null;
    let opened = false;
    switch (protocol) {
      case "ssh": {
        const built = buildOptions(ssh, withProfile);
        if (!built) return;
        void openSsh(built.options, editing ? editing.name : built.title, {
          ...extra,
          vendor: ssh.vendor,
        });
        opened = true;
        break;
      }
      case "telnet": {
        const built = buildTelnet(telnet);
        if (!built) return;
        void openTelnet(built.request, editing ? editing.name : built.title, {
          ...extra,
          vendor: telnet.vendor,
        });
        opened = true;
        break;
      }
      case "serial": {
        const built = buildSerial(serial);
        if (!built) return;
        void openSerial(built.options, editing ? editing.name : built.title, {
          ...extra,
          vendor: serial.vendor,
        });
        opened = true;
        break;
      }
      case "rdp": {
        const built = buildRdp(rdp, withProfile);
        if (!built) return;
        openRdp(built, credentialId);
        opened = true;
        break;
      }
    }
    if (!opened) return;
    if (usedId !== null) markUsed(usedId);
    close();
    setView("sessions");
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <DialogContent
        title={editing ? `Edit ${editing.name}` : "New connection"}
        description={DESCRIPTIONS[protocol]}
        className="w-[min(580px,calc(100vw-32px))]"
        onClosed={focusActiveTerminal}
      >
        <Tabs
          value={protocol}
          onValueChange={(v) => {
            setProtocol(v as ConnectProtocol);
            setTouched(false);
            setFocusFields(false);
          }}
        >
          <TabsList aria-label="Protocol" className="mb-4">
            <TabsTrigger value="ssh">SSH</TabsTrigger>
            <TabsTrigger value="telnet">Telnet</TabsTrigger>
            <TabsTrigger value="serial">Serial</TabsTrigger>
            <TabsTrigger value="rdp">RDP</TabsTrigger>
          </TabsList>
          <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
            <TabsContent value="ssh" className="flex flex-col gap-4">
              <SshFields
                autoFocus={focusFields && !editing}
                form={ssh}
                set={setSsh}
                errors={touched ? validate(ssh, withProfile) : {}}
              />
            </TabsContent>
            <TabsContent value="telnet" className="flex flex-col gap-4">
              <TelnetFields
                autoFocus={focusFields && !editing}
                form={telnet}
                set={setTelnet}
                errors={touched ? validateTelnet(telnet) : {}}
              />
            </TabsContent>
            <TabsContent value="serial" className="flex flex-col gap-4">
              <SerialFields
                autoFocus={focusFields && !editing}
                form={serial}
                set={setSerial}
                errors={touched ? validateSerial(serial) : {}}
              />
            </TabsContent>
            <TabsContent value="rdp" className="flex flex-col gap-4">
              <RdpFields
                autoFocus={focusFields && !editing}
                form={rdp}
                setForm={setRdp}
                errors={touched ? validateRdp(rdp, withProfile) : {}}
              />
            </TabsContent>
            {saving && (
              <fieldset
                aria-label="Save connection"
                className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-surface-raised p-3"
              >
                <Field label="Name" error={nameError}>
                  <Input
                    value={name}
                    autoFocus={!editing}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="core-sw1"
                  />
                </Field>
                <Field
                  label="Credential profile"
                  description={
                    withProfile
                      ? "Its username and secrets are used when connecting."
                      : "Without one, you're asked when connecting."
                  }
                >
                  <NativeSelect
                    value={credentialId ?? ""}
                    onChange={(e) =>
                      setCredentialId(e.target.value ? Number(e.target.value) : null)
                    }
                  >
                    <option value="">None</option>
                    {credentials.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.username ? ` (${c.username})` : ""}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <p className="col-span-2 text-xs text-fg-subtle">
                  A password typed above is used for this connection only and never saved.
                </p>
              </fieldset>
            )}
            <DialogFooter>
              {saving ? (
                <Button type="button" variant="secondary" onClick={() => void save()}>
                  {editing ? "Save changes" : "Save"}
                </Button>
              ) : (
                <Button type="button" variant="ghost" onClick={startSaving}>
                  <Bookmark size={14} /> Save…
                </Button>
              )}
              <span className="flex-1" />
              <Button type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" variant="primary">
                Connect
              </Button>
            </DialogFooter>
          </form>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
