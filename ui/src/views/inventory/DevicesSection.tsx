import { Server } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import type { InventorySnapshot } from "@/lib/ipc";
import { useInventory } from "@/stores/inventory";
import { DEFAULT_VIEW, useInventoryTable } from "@/stores/inventoryTable";
import { connect } from "./deviceActions";
import { DevicesTable } from "./DevicesTable";
import { DevicesToolbar } from "./DevicesToolbar";
import { filterDevices } from "./query";

export function DevicesSection({ snapshot }: { snapshot: InventorySnapshot }) {
  const search = useInventoryTable((s) => s.search);
  const facets = useInventoryTable((s) => s.facets);
  const apply = useInventoryTable((s) => s.apply);
  const setSheet = useInventory((s) => s.setSheet);
  const devices = useMemo(
    () => filterDevices(snapshot, search, facets),
    [snapshot, search, facets],
  );
  const onNew = () => setSheet({ mode: "new" });

  if (snapshot.devices.length === 0) {
    return (
      <EmptyState
        icon={<Server size={20} />}
        title="No devices yet"
        description="Add your switches, routers and servers with their management address and how to reach them. Locations, VLANs and credentials can come later."
        action={{ label: "Add a device", onClick: onNew }}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DevicesToolbar snapshot={snapshot} shown={devices.length} onNew={onNew} />
      {devices.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-fg-muted">
          <p>No devices match the search and filters.</p>
          <Button size="sm" onClick={() => apply(DEFAULT_VIEW, null)}>
            Show all devices
          </Button>
        </div>
      ) : (
        <DevicesTable
          devices={devices}
          snapshot={snapshot}
          onOpen={(d) => setSheet({ mode: "view", deviceId: d.id })}
          onConnect={(d) => connect(d)}
        />
      )}
    </div>
  );
}
