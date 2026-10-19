import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("explains the next step with a single button", async () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        icon={null}
        title="No devices"
        description="Add your first device."
        action={{ label: "Add device", onClick }}
      />,
    );
    expect(screen.getByRole("heading", { name: "No devices" })).toBeVisible();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /Add device/ }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
