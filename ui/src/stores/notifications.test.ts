import { beforeEach, describe, expect, it } from "vitest";
import { MAX_ITEMS, selectUnreadCount, useNotifications } from "./notifications";

describe("notifications store", () => {
  beforeEach(() => useNotifications.setState({ items: [] }));

  it("adds newest first as unread toasts", () => {
    const s = useNotifications.getState();
    s.notify({ title: "one" });
    s.notify({ title: "two", variant: "success" });
    const items = useNotifications.getState().items;
    expect(items.map((i) => i.title)).toEqual(["two", "one"]);
    expect(items[0]).toMatchObject({ variant: "success", toast: true, read: false });
    expect(selectUnreadCount(useNotifications.getState())).toBe(2);
  });

  it("turns backend error payloads into actionable notifications", () => {
    useNotifications.getState().notifyError(
      {
        code: "serial.denied",
        message: "Permission denied on /dev/ttyUSB0",
        hint: "sudo usermod -aG dialout $USER",
      },
      "Could not open port",
    );
    expect(useNotifications.getState().items[0]).toMatchObject({
      title: "Could not open port",
      description: "Permission denied on /dev/ttyUSB0",
      hint: "sudo usermod -aG dialout $USER",
      variant: "error",
    });
  });

  it("keeps history after the toast is dismissed and marks read", () => {
    const id = useNotifications.getState().notify({ title: "x" });
    useNotifications.getState().dismissToast(id);
    useNotifications.getState().markAllRead();
    expect(useNotifications.getState().items[0]).toMatchObject({ toast: false, read: true });
  });

  it("caps history", () => {
    for (let i = 0; i < MAX_ITEMS + 5; i++) useNotifications.getState().notify({ title: `${i}` });
    expect(useNotifications.getState().items).toHaveLength(MAX_ITEMS);
  });
});
