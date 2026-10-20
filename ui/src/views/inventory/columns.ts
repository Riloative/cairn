import { createColumnHelper, type ColumnDef, type Row } from "@tanstack/react-table";
import { useMemo } from "react";
import type { Device, InventorySnapshot } from "@/lib/ipc";
import { DEVICE_TYPE_LABEL } from "./labels";
import { compareIp, compareText, customDisplay, locationLabel } from "./query";

const col = createColumnHelper<Device>();

/** Column definitions; custom fields become extra columns. */
export function useColumns(snapshot: InventorySnapshot): ColumnDef<Device, string>[] {
  return useMemo(() => {
    const text = (fn: (d: Device) => string) => (a: Row<Device>, b: Row<Device>) =>
      compareText(fn(a.original), fn(b.original));
    const base: ColumnDef<Device, string>[] = [
      col.accessor("hostname", {
        id: "hostname",
        header: "Hostname",
        size: 220,
        sortingFn: text((d) => d.hostname),
        enableHiding: false,
      }),
      col.accessor("mgmtIp", {
        id: "mgmtIp",
        header: "Management IP",
        size: 150,
        sortingFn: (a, b) => compareIp(a.original.mgmtIp, b.original.mgmtIp),
      }),
      col.accessor((d) => DEVICE_TYPE_LABEL[d.deviceType], {
        id: "type",
        header: "Type",
        size: 150,
      }),
      col.accessor("vendor", { id: "vendor", header: "Vendor", size: 110 }),
      col.accessor("model", {
        id: "model",
        header: "Model",
        size: 150,
        sortingFn: text((d) => d.model),
      }),
      col.accessor((d) => locationLabel(d, snapshot), {
        id: "location",
        header: "Location",
        size: 240,
      }),
      col.accessor((d) => d.tags.join(", "), { id: "tags", header: "Tags", size: 160 }),
      col.accessor("serial", { id: "serial", header: "Serial", size: 140 }),
      col.accessor("firmware", { id: "firmware", header: "Firmware", size: 120 }),
      col.accessor("assetNumber", { id: "assetNumber", header: "Asset number", size: 130 }),
      col.accessor((d) => snapshot.credentials.find((c) => c.id === d.credentialId)?.name ?? "", {
        id: "credential",
        header: "Credentials",
        size: 140,
      }),
      col.accessor((d) => String(d.interfaceCount), {
        id: "interfaces",
        header: "Interfaces",
        size: 100,
        sortingFn: (a, b) => a.original.interfaceCount - b.original.interfaceCount,
      }),
      col.accessor((d) => d.vlans.join(", "), { id: "vlans", header: "VLANs", size: 140 }),
      col.accessor((d) => d.updatedAt.slice(0, 10), {
        id: "updatedAt",
        header: "Updated",
        size: 110,
      }),
    ];
    const custom = snapshot.fields.map((f) =>
      col.accessor((d) => customDisplay(f, d.custom[f.key] ?? null), {
        id: `custom.${f.key}`,
        header: f.label,
        size: 140,
        sortingFn: text((d) => customDisplay(f, d.custom[f.key] ?? null)),
      }),
    );
    return [...base, ...custom];
  }, [snapshot]);
}
