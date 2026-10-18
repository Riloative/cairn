import { useInventory } from "@/stores/inventory";
import { useNotifications } from "@/stores/notifications";

/**
 * Run an inventory change, reload the snapshot and report errors as a notification.
 * Returns the result, or `undefined` when it failed.
 */
export async function mutate<T>(
  op: () => Promise<T>,
  opts: { error: string; success?: string },
): Promise<T | undefined> {
  try {
    const result = await op();
    await useInventory.getState().load();
    if (opts.success)
      useNotifications.getState().notify({ variant: "success", title: opts.success });
    return result;
  } catch (e) {
    useNotifications.getState().notifyError(e, opts.error);
    return undefined;
  }
}
