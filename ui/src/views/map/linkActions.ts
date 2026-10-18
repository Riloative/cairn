import * as ipc from "@/lib/ipc";
import type { Link } from "@/lib/ipc";
import { confirmAction } from "@/stores/confirm";
import { useMap } from "@/stores/map";
import { mutate } from "@/views/inventory/mutate";

/** Delete a link after confirmation, then refresh the map. */
export async function deleteLink(link: Link) {
  const ok = await confirmAction({
    title: "Delete this link?",
    description: `${link.aName} ↔ ${link.bName} is removed from the map and the inventory. This is recorded in the audit log.`,
    confirmLabel: "Delete link",
    destructive: true,
  });
  if (!ok) return;
  await mutate(() => ipc.linkDelete(link.id), { error: "Could not delete the link" });
  await useMap.getState().load();
}
