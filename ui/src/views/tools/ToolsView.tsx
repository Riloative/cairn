import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { useUi, type ToolsTab } from "@/stores/ui";
import { ForwardsSection } from "./ForwardsSection";
import { TftpSection } from "./TftpSection";

/** App-wide tools: port forwards over SSH sessions and the TFTP server. */
export function ToolsView() {
  const tab = useUi((s) => s.toolsTab);
  const setTab = useUi((s) => s.setToolsTab);
  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as ToolsTab)}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="border-b border-border px-6 pt-4">
        <h1 className="mb-3 text-[15px] font-semibold tracking-tight">Tools</h1>
        <TabsList aria-label="Tools">
          <TabsTrigger value="forwards">Port forwards</TabsTrigger>
          <TabsTrigger value="tftp">TFTP server</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="forwards" className="min-h-0 flex-1 overflow-y-auto p-6">
        <ForwardsSection />
      </TabsContent>
      <TabsContent value="tftp" className="min-h-0 flex-1 overflow-y-auto p-6">
        <TftpSection />
      </TabsContent>
    </Tabs>
  );
}
