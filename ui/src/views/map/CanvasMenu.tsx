import { Eye, LayoutGrid, Pencil, Plus, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/Menu";
import * as ipc from "@/lib/ipc";
import type { Link } from "@/lib/ipc";
import type { MapViewRef } from "@/map/model";
import { useMap } from "@/stores/map";
import { mutate } from "@/views/inventory/mutate";
import { deleteLink } from "./linkActions";
import { useMapUi } from "./mapUi";
import type { LinkEdge } from "./types";

export type CanvasMenuState =
  | { kind: "edge"; x: number; y: number; edge: LinkEdge }
  | { kind: "pane"; x: number; y: number; flowX: number; flowY: number };

async function toggleLabel(link: Link, key: "ports" | "speed" | "vlans", shown: boolean) {
  await mutate(() => ipc.linkSave({ ...link, labels: { ...link.labels, [key]: !shown } }), {
    error: "Could not change the labels",
  });
  await useMap.getState().load();
}

/** Right-click menu for links and the empty canvas, opened at the cursor. */
export function CanvasMenu({
  state,
  onClose,
  view,
  viewKey,
  selection,
  onLayout,
}: {
  state: CanvasMenuState | null;
  onClose: () => void;
  view: MapViewRef;
  viewKey: string;
  selection: string[];
  onLayout: (scope: "all" | "selection") => void;
}) {
  const prefs = useMap((s) => s.data?.prefs);
  if (!state || !prefs) return null;
  const link =
    state.kind === "edge" && state.edge.data?.links.length === 1
      ? state.edge.data.links[0]
      : undefined;
  const shown = (k: "ports" | "speed" | "vlans") =>
    link ? (link.labels[k] ?? prefs.labels[k]) : false;
  const layoutable = selection.filter((id) => id.startsWith("d:") || id.startsWith("b:")).length;

  return (
    <DropdownMenu open onOpenChange={(o) => !o && onClose()} modal={false}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden className="fixed size-0" style={{ left: state.x, top: state.y }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
        {state.kind === "edge" && link && (
          <>
            <DropdownMenuItem
              icon={<Pencil size={14} />}
              onSelect={() => useMapUi.getState().setLinkDialog({ mode: "edit", link })}
            >
              Edit link…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {(["ports", "speed", "vlans"] as const).map((k) => (
              <DropdownMenuItem
                key={k}
                icon={<Eye size={14} />}
                onSelect={() => void toggleLabel(link, k, shown(k))}
              >
                {shown(k) ? "Hide" : "Show"}{" "}
                {k === "ports" ? "port names" : k === "speed" ? "speed" : "VLANs"}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              icon={<Trash2 size={14} />}
              destructive
              onSelect={() => void deleteLink(link)}
            >
              Delete link
            </DropdownMenuItem>
          </>
        )}
        {state.kind === "edge" && !link && (
          <DropdownMenuItem disabled>
            {state.edge.data?.links.length} cables — open the building to edit
          </DropdownMenuItem>
        )}
        {state.kind === "pane" && (
          <>
            {view.kind !== "rack" && (
              <DropdownMenuItem
                icon={<Plus size={14} />}
                onSelect={() =>
                  useMapUi.getState().setZoneDialog({
                    id: 0,
                    view: viewKey,
                    name: "",
                    color: "",
                    x: Math.round(state.flowX),
                    y: Math.round(state.flowY),
                    width: 320,
                    height: 200,
                    locked: false,
                  })
                }
              >
                Add zone here…
              </DropdownMenuItem>
            )}
            <DropdownMenuItem icon={<LayoutGrid size={14} />} onSelect={() => onLayout("all")}>
              Auto-layout all
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<LayoutGrid size={14} />}
              disabled={layoutable < 2}
              onSelect={() => onLayout("selection")}
            >
              Auto-layout selection
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
