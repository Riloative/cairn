import { beforeEach, describe, expect, it } from "vitest";
import { useSessions, type SessionTab } from "./sessions";

const tab = (id: string): SessionTab => ({ id, title: id, protocol: "ssh", state: "connected" });

describe("sessions store", () => {
  beforeEach(() => useSessions.setState({ tabs: [], activeId: null }));

  it("opens tabs and activates the newest", () => {
    useSessions.getState().open(tab("a"));
    useSessions.getState().open(tab("b"));
    expect(useSessions.getState().activeId).toBe("b");
  });

  it("closing the active tab focuses the right neighbour, then the left", () => {
    const s = useSessions.getState();
    ["a", "b", "c"].forEach((id) => s.open(tab(id)));
    s.activate("b");
    s.close("b");
    expect(useSessions.getState().activeId).toBe("c");
    useSessions.getState().close("c");
    expect(useSessions.getState().activeId).toBe("a");
    useSessions.getState().close("a");
    expect(useSessions.getState().activeId).toBeNull();
  });

  it("closing an inactive tab keeps the active one", () => {
    const s = useSessions.getState();
    ["a", "b"].forEach((id) => s.open(tab(id)));
    s.close("a");
    expect(useSessions.getState().activeId).toBe("b");
  });

  it("cycles through tabs", () => {
    const s = useSessions.getState();
    ["a", "b", "c"].forEach((id) => s.open(tab(id)));
    s.activateRelative(1);
    expect(useSessions.getState().activeId).toBe("a");
    useSessions.getState().activateRelative(-1);
    expect(useSessions.getState().activeId).toBe("c");
  });

  it("updates state", () => {
    useSessions.getState().open(tab("a"));
    useSessions.getState().setState("a", "error");
    expect(useSessions.getState().tabs[0]?.state).toBe("error");
  });
});
