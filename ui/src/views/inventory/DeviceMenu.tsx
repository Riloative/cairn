import { Copy, CopyPlus, Globe, Pencil, PlugZap, ScrollText, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/Menu";
import type { Device } from "@/lib/ipc";
import { useInventory } from "@/stores/inventory";
import { grabConfig } from "@/views/configs/grab";
import {
  canOpen,
  connect,
  copyIp,
  deleteDevice,
  duplicateDevice,
  methodLabel,
} from "./deviceActions";

/** Right-click menu for a device row. */
export function DeviceContextMenu({ device, children }: { device: Device; children: ReactNode }) {
  const setSheet = useInventory((s) => s.setSheet);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {device.connections.map((m, i) => (
          <ContextMenuItem
            key={i}
            icon={m.kind === "web" ? <Globe size={14} /> : <PlugZap size={14} />}
            disabled={!canOpen(m)}
            onSelect={() => connect(device, i)}
          >
            {methodLabel(m)}
          </ContextMenuItem>
        ))}
        {device.connections.length > 0 && <ContextMenuSeparator />}
        <ContextMenuItem
          icon={<Pencil size={14} />}
          onSelect={() => setSheet({ mode: "edit", deviceId: device.id })}
        >
          Edit
        </ContextMenuItem>
        <ContextMenuItem
          icon={<CopyPlus size={14} />}
          onSelect={() => void duplicateDevice(device)}
        >
          Duplicate
        </ContextMenuItem>
        <ContextMenuItem
          icon={<Copy size={14} />}
          disabled={!device.mgmtIp}
          onSelect={() => void copyIp(device)}
        >
          Copy IP
        </ContextMenuItem>
        <ContextMenuItem
          icon={<ScrollText size={14} />}
          disabled={!device.connections.some((m) => m.kind === "ssh")}
          onSelect={() => void grabConfig(device)}
        >
          Grab config
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          icon={<Trash2 size={14} />}
          destructive
          onSelect={() => void deleteDevice(device)}
        >
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
