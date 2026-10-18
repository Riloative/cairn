import { Copy, CopyPlus, Globe, MoreHorizontal, Pencil, PlugZap, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/Menu";
import { Sheet, SheetContent } from "@/components/ui/Sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import type { Device, InventorySnapshot } from "@/lib/ipc";
import { useInventory } from "@/stores/inventory";
import {
  canOpen,
  connect,
  copyIp,
  deleteDevice,
  duplicateDevice,
  methodLabel,
} from "./deviceActions";
import { DeviceForm } from "./DeviceForm";
import { DeviceTypeIcon } from "./DeviceTypeIcon";
import { InterfacesPanel } from "./InterfacesPanel";
import { DEVICE_TYPE_LABEL } from "./labels";
import { Markdown } from "./Markdown";
import { customDisplay, locationLabel } from "./query";
import { formatVlanList } from "./validate";
import { finishEdit, NEW_DEVICE } from "./model";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 py-1">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function Overview({ device, snapshot }: { device: Device; snapshot: InventorySnapshot }) {
  const cred = snapshot.credentials.find((c) => c.id === device.credentialId);
  const vlans = device.vlans.map(
    (v) => snapshot.vlans.find((x) => x.vid === v) ?? { vid: v, name: "", color: "" },
  );
  return (
    <div className="flex flex-col gap-5 p-4">
      <dl className="text-[13px]">
        <Row label="Management IP">
          <span className="font-mono text-xs">{device.mgmtIp || "—"}</span>
        </Row>
        <Row label="Type">{DEVICE_TYPE_LABEL[device.deviceType]}</Row>
        <Row label="Vendor / model">
          {device.vendor}
          {device.model && ` ${device.model}`}
        </Row>
        {device.serial && <Row label="Serial">{device.serial}</Row>}
        {device.firmware && <Row label="Firmware">{device.firmware}</Row>}
        <Row label="Location">{locationLabel(device, snapshot) || "—"}</Row>
        <Row label="Credentials">{cred?.name ?? "None"}</Row>
        {vlans.length > 0 && (
          <Row label="VLANs">
            <span className="flex flex-wrap gap-1" title={formatVlanList(device.vlans)}>
              {vlans.slice(0, 40).map((v) => (
                <span
                  key={v.vid}
                  className="inline-flex items-center gap-1 rounded-sm bg-surface-raised px-1.5 text-xs"
                  title={v.name || undefined}
                >
                  {v.color && (
                    <span
                      aria-hidden
                      className="size-2 rounded-full"
                      style={{ background: v.color }}
                    />
                  )}
                  {v.vid}
                </span>
              ))}
              {vlans.length > 40 && (
                <span className="text-xs text-fg-subtle">+{vlans.length - 40}</span>
              )}
            </span>
          </Row>
        )}
        {device.tags.length > 0 && (
          <Row label="Tags">
            <span className="flex flex-wrap gap-1">
              {device.tags.map((t) => (
                <span key={t} className="rounded-sm bg-accent-subtle px-1.5 text-xs">
                  {t}
                </span>
              ))}
            </span>
          </Row>
        )}
        {snapshot.fields
          .filter((f) => device.custom[f.key] !== undefined && device.custom[f.key] !== null)
          .map((f) => (
            <Row key={f.id} label={f.label}>
              {customDisplay(f, device.custom[f.key] ?? null)}
            </Row>
          ))}
      </dl>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">Connect</h3>
        {device.connections.length === 0 ? (
          <p className="text-fg-muted">No connection methods. Edit the device to add one.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {device.connections.map((m, i) => (
              <Button
                key={i}
                size="sm"
                variant={i === 0 ? "primary" : "secondary"}
                disabled={!canOpen(m)}
                title={canOpen(m) ? undefined : "RDP sessions arrive in a later version"}
                onClick={() => connect(device, i)}
              >
                {m.kind === "web" ? <Globe size={14} /> : <PlugZap size={14} />}
                {methodLabel(m)}
                {m.kind === "ssh" && m.legacy.length > 0 && (
                  <span
                    title={`Legacy algorithms: ${m.legacy.join(", ")}`}
                    className="rounded-sm bg-warning/20 px-1 text-[11px] text-warning"
                  >
                    legacy
                  </span>
                )}
              </Button>
            ))}
          </div>
        )}
      </section>

      {device.notes.trim() && (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">Notes</h3>
          <Markdown text={device.notes} />
        </section>
      )}
    </div>
  );
}

/** Side sheet: device details, interfaces, and the create/edit form. */
export function DeviceSheet({ snapshot }: { snapshot: InventorySnapshot }) {
  const sheet = useInventory((s) => s.sheet);
  const setSheet = useInventory((s) => s.setSheet);
  const device =
    sheet && sheet.mode !== "new"
      ? snapshot.devices.find((d) => d.id === sheet.deviceId)
      : undefined;
  const open = sheet !== null && (sheet.mode === "new" || device !== undefined);

  let title: ReactNode = "New device";
  let body: ReactNode = null;
  let actions: ReactNode = null;
  if (sheet?.mode === "new") {
    body = (
      <DeviceForm
        snapshot={snapshot}
        initial={NEW_DEVICE}
        onDone={(saved) => finishEdit(saved, null)}
      />
    );
  } else if (device && sheet?.mode === "edit") {
    title = `Edit ${device.hostname}`;
    body = (
      <DeviceForm
        key={device.id}
        snapshot={snapshot}
        initial={device}
        onDone={(saved) => finishEdit(saved, device.id)}
      />
    );
  } else if (device && sheet?.mode === "view") {
    title = (
      <span className="flex items-center gap-2">
        <DeviceTypeIcon type={device.deviceType} size={14} />
        {device.hostname}
      </span>
    );
    actions = (
      <>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setSheet({ mode: "edit", deviceId: device.id })}
        >
          <Pencil size={14} /> Edit
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" aria-label="More actions">
              <MoreHorizontal size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              icon={<CopyPlus size={14} />}
              onSelect={() => void duplicateDevice(device)}
            >
              Duplicate with interfaces
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<Copy size={14} />}
              disabled={!device.mgmtIp}
              onSelect={() => void copyIp(device)}
            >
              Copy IP
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              icon={<Trash2 size={14} />}
              destructive
              onSelect={() => void deleteDevice(device)}
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    );
    body = (
      <Tabs
        value={sheet.tab ?? "overview"}
        onValueChange={(v) =>
          setSheet({ mode: "view", deviceId: device.id, tab: v as "overview" | "interfaces" })
        }
      >
        <TabsList className="mx-4 mt-3">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="interfaces">Interfaces ({device.interfaceCount})</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Overview device={device} snapshot={snapshot} />
        </TabsContent>
        <TabsContent value="interfaces">
          <InterfacesPanel device={device} />
        </TabsContent>
      </Tabs>
    );
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && setSheet(null)}>
      {open && (
        <SheetContent
          title={title}
          description={
            device
              ? [device.mgmtIp, device.model].filter(Boolean).join(" · ") || undefined
              : undefined
          }
          actions={actions}
          className="w-[min(600px,calc(100vw-16px))]"
        >
          {body}
        </SheetContent>
      )}
    </Sheet>
  );
}
