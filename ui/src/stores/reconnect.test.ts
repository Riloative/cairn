import { describe, expect, it } from "vitest";
import { BACKOFF_SECS, backoffDelay, useReconnect } from "./reconnect";

describe("reconnect backoff", () => {
  it("grows and then gives up", () => {
    expect(backoffDelay(0)).toBe(2000);
    expect(backoffDelay(3)).toBe(16000);
    expect(backoffDelay(BACKOFF_SECS.length)).toBeNull();
  });

  it("tracks state per tab", () => {
    useReconnect.getState().set("a", { attempt: 1, nextAt: 5, message: "lost" });
    expect(useReconnect.getState().byTab.a?.attempt).toBe(1);
    useReconnect.getState().clear("a");
    expect(useReconnect.getState().byTab.a).toBeUndefined();
  });
});
