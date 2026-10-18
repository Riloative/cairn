import { useEffect } from "react";
import { Skeleton } from "@/components/ui/Skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { useInventory, type InventorySection } from "@/stores/inventory";
import { CredentialsSection } from "./CredentialsSection";
import { DeviceSheet } from "./DeviceSheet";
import { DevicesSection } from "./DevicesSection";
import { FieldsSection } from "./FieldsSection";
import { LocationsSection } from "./LocationsSection";
import { VlansSection } from "./VlansSection";

const SECTIONS: readonly { value: InventorySection; label: string }[] = [
  { value: "devices", label: "Devices" },
  { value: "locations", label: "Locations" },
  { value: "vlans", label: "VLANs" },
  { value: "credentials", label: "Credentials" },
  { value: "fields", label: "Fields" },
];

export function InventoryView() {
  const snapshot = useInventory((s) => s.snapshot);
  const error = useInventory((s) => s.error);
  const section = useInventory((s) => s.section);
  const setSection = useInventory((s) => s.setSection);
  const load = useInventory((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Tabs
      value={section}
      onValueChange={(v) => setSection(v as InventorySection)}
      className="flex h-full min-h-0 flex-col"
    >
      <header className="flex items-center gap-4 px-4 pt-3 pb-2">
        <h1 className="text-[15px] font-semibold tracking-tight">Inventory</h1>
        <TabsList aria-label="Inventory sections">
          {SECTIONS.map((s) => (
            <TabsTrigger key={s.value} value={s.value}>
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </header>
      {!snapshot ? (
        <div className="flex flex-col gap-2 p-4" aria-busy>
          {error ? (
            <p role="alert" className="text-danger">
              {error}
            </p>
          ) : (
            Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-8" />)
          )}
        </div>
      ) : (
        <>
          <TabsContent value="devices" className="min-h-0 flex-1">
            <DevicesSection snapshot={snapshot} />
          </TabsContent>
          <TabsContent value="locations" className="min-h-0 flex-1 overflow-y-auto">
            <LocationsSection snapshot={snapshot} />
          </TabsContent>
          <TabsContent value="vlans" className="min-h-0 flex-1 overflow-y-auto">
            <VlansSection snapshot={snapshot} />
          </TabsContent>
          <TabsContent value="credentials" className="min-h-0 flex-1 overflow-y-auto">
            <CredentialsSection snapshot={snapshot} />
          </TabsContent>
          <TabsContent value="fields" className="min-h-0 flex-1 overflow-y-auto">
            <FieldsSection snapshot={snapshot} />
          </TabsContent>
          <DeviceSheet snapshot={snapshot} />
        </>
      )}
    </Tabs>
  );
}
