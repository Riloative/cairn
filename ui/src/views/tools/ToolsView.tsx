import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { useUi, type ToolsTab } from "@/stores/ui";
import { TftpSection } from "./TftpSection";

/** App-wide tools: the TFTP server (and the port-forward manager). */
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
          <TabsTrigger value="tftp">TFTP server</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="tftp" className="min-h-0 flex-1 overflow-y-auto p-6">
        <TftpSection />
      </TabsContent>
    </Tabs>
  );
}
