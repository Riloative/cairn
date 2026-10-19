import { useEffect } from "react";
import { openSaved, targetOf } from "@/connect/saved";
import { useActions, type Action } from "@/lib/actions";
import type { SavedConnection } from "@/lib/ipc";
import { useSavedConnections } from "@/stores/savedConnections";
import { useUi } from "@/stores/ui";

/** Palette entries for every saved connection: connect and edit. */
export function savedActions(list: readonly SavedConnection[]): Action[] {
  return list.flatMap((s) => {
    const keywords = [targetOf(s), s.protocol, "saved", "bookmark"];
    return [
      {
        id: `saved.connect.${s.id}`,
        title: `Connect to ${s.name}`,
        group: "Saved connections",
        keywords,
        run: () => void openSaved(s),
      },
      {
        id: `saved.edit.${s.id}`,
        title: `Edit saved connection ${s.name}`,
        group: "Saved connections",
        keywords,
        run: () => useUi.getState().editSaved(s),
      },
    ];
  });
}

/** Load saved connections after unlock and keep their palette entries current. */
export function useSavedActions() {
  const register = useActions((s) => s.register);
  const list = useSavedConnections((s) => s.list);
  useEffect(() => {
    void useSavedConnections.getState().load();
  }, []);
  useEffect(() => (list ? register(savedActions(list)) : undefined), [register, list]);
}
