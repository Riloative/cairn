import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeBackend } from "@/test/fakeBackend";
import { broadcastPeers, useBroadcast } from "./broadcast";
import { useSessions } from "./sessions";

let backend: FakeBackend;

beforeEach(() => {
  backend = new FakeBackend("unlocked");
  useBroadcast.setState({ members: [], startedAt: null, pickerOpen: false });
  useSessions.setState({
    tabs: ["a", "b", "c"].map((id) => ({
      id,
      title: `sw-${id}`,
      protocol: "ssh" as const,
      state: "connected" as const,
    })),
    activeId: "a",
  });
});

afterEach(() => backend.dispose());

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("broadcast", () => {
  it("mirrors input only between members and audits start and end by label", async () => {
    useBroadcast.getState().start(["a", "b", "b"]);
    expect(useBroadcast.getState().members).toEqual(["a", "b"]);
    expect(broadcastPeers("a")).toEqual(["b"]);
    expect(broadcastPeers("c")).toEqual([]);
    await flush();
    expect(backend.audit[0]).toMatchObject({
      kind: "broadcast_started",
      payload: { targets: ["sw-a", "sw-b"] },
    });
    useBroadcast.getState().stop();
    await flush();
    expect(broadcastPeers("a")).toEqual([]);
    expect(backend.audit[0]?.kind).toBe("broadcast_ended");
  });

  it("needs two members and ends when a member closes and one is left", async () => {
    useBroadcast.getState().start(["a"]);
    expect(useBroadcast.getState().members).toEqual([]);
    useBroadcast.getState().start(["a", "b", "c"]);
    useBroadcast.getState().removeTab("c");
    expect(useBroadcast.getState().members).toEqual(["a", "b"]);
    useBroadcast.getState().removeTab("b");
    expect(useBroadcast.getState().members).toEqual([]);
    await flush();
    expect(backend.audit.map((e) => e.kind)).toEqual(["broadcast_ended", "broadcast_started"]);
  });
});
