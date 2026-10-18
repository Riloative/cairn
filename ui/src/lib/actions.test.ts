import { beforeEach, describe, expect, it, vi } from "vitest";
import { availableActions, useActions, type Action } from "./actions";

const action = (id: string, extra: Partial<Action> = {}): Action => ({
  id,
  title: id,
  group: "Test",
  run: vi.fn(),
  ...extra,
});

describe("action registry", () => {
  beforeEach(() => useActions.setState({ actions: new Map() }));

  it("registers and unregisters", () => {
    const off = useActions.getState().register([action("a"), action("b")]);
    expect(useActions.getState().actions.size).toBe(2);
    off();
    expect(useActions.getState().actions.size).toBe(0);
  });

  it("does not remove an action re-registered by someone else", () => {
    const off = useActions.getState().register([action("a")]);
    const replacement = action("a", { title: "new" });
    useActions.getState().register([replacement]);
    off();
    expect(useActions.getState().actions.get("a")).toBe(replacement);
  });

  it("filters disabled actions", () => {
    useActions.getState().register([action("on"), action("off", { enabled: () => false })]);
    expect(availableActions(useActions.getState().actions).map((a) => a.id)).toEqual(["on"]);
  });
});
