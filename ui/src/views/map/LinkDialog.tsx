import { Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { NativeSelect } from "@/components/ui/NativeSelect";
import { cn } from "@/lib/cn";
import * as ipc from "@/lib/ipc";
import type { Device, Interface, Link, LinkMedia } from "@/lib/ipc";
import { MEDIA_LABEL } from "@/map/colors";
import { useInventory } from "@/stores/inventory";
import { useMap } from "@/stores/map";
import { useNotifications } from "@/stores/notifications";
import { IFACE_TEMPLATE } from "@/views/inventory/model";
import { mutate } from "@/views/inventory/mutate";
import { parseVlanList } from "@/views/inventory/validate";
import { deleteLink } from "./linkActions";
import { useMapUi, type LinkDialogState } from "./mapUi";

const MEDIA = Object.entries(MEDIA_LABEL) as [LinkMedia, string][];

type Override = "default" | "show" | "hide";
const toOverride = (v: boolean | null): Override => (v === null ? "default" : v ? "show" : "hide");
const fromOverride = (o: Override): boolean | null => (o === "default" ? null : o === "show");

/** Searchable interface list for one end of a link; can create a missing interface. */
function InterfacePicker({
  device,
  interfaces,
  busy,
  value,
  onChange,
  onCreate,
}: {
  device: Device;
  interfaces: Interface[] | null;
  busy: Set<number>;
  value: number | null;
  onChange: (id: number) => void;
  onCreate: (name: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const shown = (interfaces ?? []).filter(
    (i) =>
      !filter ||
      i.name.toLowerCase().includes(filter.toLowerCase()) ||
      i.description.toLowerCase().includes(filter.toLowerCase()),
  );
  const exact = (interfaces ?? []).some((i) => i.name === filter.trim());
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="truncate text-xs font-medium text-fg-muted">{device.hostname}</span>
      <div className="relative">
        <Search
          size={12}
          className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-subtle"
        />
        <Input
          aria-label={`Filter ${device.hostname} interfaces`}
          className="pl-7"
          placeholder="Gi1/0/1"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div
        role="radiogroup"
        aria-label={`${device.hostname} interface`}
        className="h-44 overflow-y-auto rounded-md border border-border p-1"
      >
        {interfaces === null && <p className="p-2 text-xs text-fg-subtle">Loading…</p>}
        {shown.map((i) => {
          const taken = busy.has(i.id);
          return (
            <button
              key={i.id}
              type="button"
              role="radio"
              aria-checked={value === i.id}
              disabled={taken}
              title={taken ? "Already connected" : i.description || undefined}
              onClick={() => onChange(i.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13px] hover:bg-surface-raised disabled:opacity-40",
                value === i.id && "bg-accent-subtle hover:bg-accent-subtle",
              )}
            >
              <span className="font-mono text-xs">{i.name}</span>
              <span className="truncate text-xs text-fg-subtle">
                {taken ? "connected" : i.description}
              </span>
            </button>
          );
        })}
        {interfaces !== null && filter.trim() && !exact && (
          <button
            type="button"
            onClick={() => onCreate(filter.trim())}
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13px] text-accent-text hover:bg-surface-raised"
          >
            <Plus size={12} /> Create {filter.trim()}
          </button>
        )}
        {interfaces?.length === 0 && !filter && (
          <p className="p-2 text-xs text-fg-subtle">
            No interfaces yet. Type a name to create one.
          </p>
        )}
      </div>
    </div>
  );
}

const BLANK = (a: number, b: number): Link => ({
  id: 0,
  aInterfaceId: a,
  bInterfaceId: b,
  aDeviceId: 0,
  bDeviceId: 0,
  aName: "",
  bName: "",
  media: "copper",
  speed: "",
  vlans: "",
  lag: "",
  description: "",
  labels: { ports: null, speed: null, vlans: null },
});

export function LinkDialog() {
  const state = useMapUi((s) => s.linkDialog);
  const inv = useInventory((s) => s.snapshot);
  const ids = state
    ? state.mode === "new"
      ? [state.aDeviceId, state.bDeviceId]
      : [state.link.aDeviceId, state.link.bDeviceId]
    : null;
  const devA = inv?.devices.find((d) => d.id === ids?.[0]);
  const devB = inv?.devices.find((d) => d.id === ids?.[1]);
  if (!state || !devA || !devB) return null;
  const key = state.mode === "edit" ? `link:${state.link.id}` : `new:${devA.id}:${devB.id}`;
  return <LinkForm key={key} state={state} devA={devA} devB={devB} />;
}

function LinkForm({
  state,
  devA,
  devB,
}: {
  state: NonNullable<LinkDialogState>;
  devA: Device;
  devB: Device;
}) {
  const close = () => useMapUi.getState().setLinkDialog(null);
  const links = useMap((s) => s.data?.links);
  const [ifA, setIfA] = useState<Interface[] | null>(null);
  const [ifB, setIfB] = useState<Interface[] | null>(null);
  const [link, setLink] = useState<Link>(() => (state.mode === "edit" ? state.link : BLANK(0, 0)));
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    void ipc.interfacesList(devA.id).then(setIfA);
    void ipc.interfacesList(devB.id).then(setIfB);
  }, [devA.id, devB.id]);

  const busy = useMemo(() => {
    const s = new Set<number>();
    for (const l of links ?? []) {
      if (l.id === link.id) continue;
      s.add(l.aInterfaceId);
      s.add(l.bInterfaceId);
    }
    return s;
  }, [links, link.id]);

  const set = <K extends keyof Link>(k: K, v: Link[K]) => setLink((l) => ({ ...l, [k]: v }));
  const vlanError =
    parseVlanList(link.vlans) === null ? "Use VLAN ids and ranges like 10,20-30." : undefined;
  const pickError =
    touched && (!link.aInterfaceId || !link.bInterfaceId)
      ? "Choose an interface on each side."
      : undefined;

  async function create(device: Device, name: string, side: "a" | "b") {
    try {
      const saved = await ipc.interfaceSave({ ...IFACE_TEMPLATE, deviceId: device.id, name });
      if (side === "a") {
        setIfA((l) => [...(l ?? []), saved]);
        set("aInterfaceId", saved.id);
      } else {
        setIfB((l) => [...(l ?? []), saved]);
        set("bInterfaceId", saved.id);
      }
      void useInventory.getState().load();
    } catch (e) {
      useNotifications.getState().notifyError(e, `Could not create ${name}`);
    }
  }

  function pickSpeed(id: number, list: Interface[] | null) {
    const speed = list?.find((i) => i.id === id)?.speed;
    if (speed && !link.speed) set("speed", speed);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!link.aInterfaceId || !link.bInterfaceId || vlanError) return;
    const saved = await mutate(() => ipc.linkSave(link), { error: "Could not save the link" });
    if (saved) {
      await useMap.getState().load();
      close();
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent
        title={state.mode === "new" ? "New link" : "Edit link"}
        description="Interface to interface. Each interface can be part of one link."
        className="w-[min(640px,calc(100vw-32px))]"
      >
        <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
          <div className="grid grid-cols-2 gap-4">
            <InterfacePicker
              device={devA}
              interfaces={ifA}
              busy={busy}
              value={link.aInterfaceId || null}
              onChange={(id) => {
                set("aInterfaceId", id);
                pickSpeed(id, ifA);
              }}
              onCreate={(n) => void create(devA, n, "a")}
            />
            <InterfacePicker
              device={devB}
              interfaces={ifB}
              busy={busy}
              value={link.bInterfaceId || null}
              onChange={(id) => {
                set("bInterfaceId", id);
                pickSpeed(id, ifB);
              }}
              onCreate={(n) => void create(devB, n, "b")}
            />
          </div>
          {pickError && (
            <p role="alert" className="text-xs text-danger">
              {pickError}
            </p>
          )}
          <div className="grid grid-cols-3 gap-3">
            <Field label="Media">
              <NativeSelect
                value={link.media}
                onChange={(e) => set("media", e.target.value as LinkMedia)}
              >
                {MEDIA.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Speed" description="e.g. 1G, 10G">
              <Input value={link.speed} onChange={(e) => set("speed", e.target.value)} />
            </Field>
            <Field label="LAG" description="e.g. Po1, ae0">
              <Input
                spellCheck={false}
                value={link.lag}
                onChange={(e) => set("lag", e.target.value)}
              />
            </Field>
          </div>
          <div className="grid grid-cols-[1fr_2fr] gap-3">
            <Field label="VLANs" error={vlanError}>
              <Input
                spellCheck={false}
                value={link.vlans}
                onChange={(e) => set("vlans", e.target.value)}
              />
            </Field>
            <Field label="Description">
              <Input
                value={link.description}
                onChange={(e) => set("description", e.target.value)}
              />
            </Field>
          </div>
          <fieldset className="grid grid-cols-3 gap-3">
            <legend className="mb-1.5 text-xs font-medium text-fg-muted">
              Labels on this link
            </legend>
            {(["ports", "speed", "vlans"] as const).map((k) => (
              <Field
                key={k}
                label={k === "ports" ? "Port names" : k === "speed" ? "Speed" : "VLANs"}
              >
                <NativeSelect
                  value={toOverride(link.labels[k])}
                  onChange={(e) =>
                    set("labels", { ...link.labels, [k]: fromOverride(e.target.value as Override) })
                  }
                >
                  <option value="default">Map default</option>
                  <option value="show">Show</option>
                  <option value="hide">Hide</option>
                </NativeSelect>
              </Field>
            ))}
          </fieldset>
          <DialogFooter>
            {state.mode === "edit" && (
              <Button
                type="button"
                variant="ghost"
                className="mr-auto text-danger"
                onClick={() => {
                  close();
                  void deleteLink(state.link);
                }}
              >
                Delete link
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              {state.mode === "new" ? "Add link" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
