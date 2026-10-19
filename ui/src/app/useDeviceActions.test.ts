import { describe, expect, it, vi } from "vitest";
import { useInventory } from "@/stores/inventory";
import { useUi } from "@/stores/ui";
import { openDevice } from "@/terminal/controller";
import { NEW_DEVICE } from "@/views/inventory/model";
import { deviceActions } from "./useDeviceActions";

vi.mock("@/terminal/controller", () => ({ openDevice: vi.fn() }));

describe("device palette actions", () => {
  it("offers connect and show for each device", () => {
    const actions = deviceActions([
      { ...NEW_DEVICE, id: 7, hostname: "core-sw1", mgmtIp: "10.0.0.1", tags: ["core"] },
      { ...NEW_DEVICE, id: 8, hostname: "nas", connections: [] },
    ]);
    expect(actions.map((a) => a.title)).toEqual([
      "Connect to core-sw1",
      "Show core-sw1",
      "Show nas",
    ]);
    expect(actions[0]?.keywords).toContain("10.0.0.1");
    void actions[0]?.run();
    expect(openDevice).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), 0);
    expect(useUi.getState().view).toBe("sessions");
    void actions[2]?.run();
    expect(useUi.getState().view).toBe("inventory");
    expect(useInventory.getState().sheet).toEqual({ mode: "view", deviceId: 8 });
  });
});
