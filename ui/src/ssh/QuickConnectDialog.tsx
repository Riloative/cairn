import { useCallback, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { SerialFields } from "@/connect/SerialFields";
import { buildSerial, EMPTY_SERIAL, validateSerial, type SerialForm } from "@/connect/serialForm";
import { TelnetFields } from "@/connect/TelnetFields";
import { buildTelnet, EMPTY_TELNET, validateTelnet, type TelnetForm } from "@/connect/telnetForm";
import { useUi, type ConnectProtocol } from "@/stores/ui";
import { focusActiveTerminal, openSerial, openSsh, openTelnet } from "@/terminal/controller";
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
  ssh: "Connect to a device by address. Saved devices arrive with the inventory.",
  telnet: "Telnet or raw TCP, including console-server ports (reverse Telnet).",
  serial: "A console cable on this machine. The port list follows plugging and unplugging.",
};

/** Quick-connect dialog with SSH, Telnet and Serial tabs (`Mod+N`). */
export function QuickConnectDialog() {
  const open = useUi((s) => s.quickConnectOpen);
  const setOpen = useUi((s) => s.setQuickConnectOpen);
  const protocol = useUi((s) => s.connectProtocol);
  const setProtocol = useUi((s) => s.setConnectProtocol);
  const setView = useUi((s) => s.setView);
  const [ssh, setSsh, replaceSsh] = useForm<QuickConnectForm>(EMPTY_FORM);
  const [telnet, setTelnet] = useForm<TelnetForm>(EMPTY_TELNET);
  const [serial, setSerial] = useForm<SerialForm>(EMPTY_SERIAL);
  const [touched, setTouched] = useState(false);
  // Focus the first field when the dialog opens, but not when switching tabs (keyboard
  // users stay on the tab list).
  const [focusFields, setFocusFields] = useState(true);

  function close() {
    setOpen(false);
    // Never keep a typed password around after the dialog closes.
    replaceSsh((f) => ({ ...f, password: "" }));
    setTouched(false);
    setFocusFields(true);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    switch (protocol) {
      case "ssh": {
        const built = buildOptions(ssh);
        if (!built) return;
        close();
        setView("sessions");
        void openSsh(built.options, built.title, { vendor: ssh.vendor });
        return;
      }
      case "telnet": {
        const built = buildTelnet(telnet);
        if (!built) return;
        close();
        setView("sessions");
        void openTelnet(built.request, built.title, { vendor: telnet.vendor });
        return;
      }
      case "serial": {
        const built = buildSerial(serial);
        if (!built) return;
        close();
        setView("sessions");
        void openSerial(built.options, built.title, { vendor: serial.vendor });
        return;
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <DialogContent
        title="New connection"
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
          </TabsList>
          <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
            <TabsContent value="ssh" className="flex flex-col gap-4">
              <SshFields
                autoFocus={focusFields}
                form={ssh}
                set={setSsh}
                errors={touched ? validate(ssh) : {}}
              />
            </TabsContent>
            <TabsContent value="telnet" className="flex flex-col gap-4">
              <TelnetFields
                autoFocus={focusFields}
                form={telnet}
                set={setTelnet}
                errors={touched ? validateTelnet(telnet) : {}}
              />
            </TabsContent>
            <TabsContent value="serial" className="flex flex-col gap-4">
              <SerialFields
                autoFocus={focusFields}
                form={serial}
                set={setSerial}
                errors={touched ? validateSerial(serial) : {}}
              />
            </TabsContent>
            <DialogFooter>
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
