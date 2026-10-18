import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { modKeyLabel } from "@/lib/platform";
import { Kbd } from "./Kbd";

describe("Kbd", () => {
  it("renders a keyboard key", () => {
    render(<Kbd>{modKeyLabel()}</Kbd>);
    const key = screen.getByText(/⌘|Ctrl/);
    expect(key.tagName).toBe("KBD");
  });
});
