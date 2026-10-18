import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders the section navigation", () => {
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Sections" });
    for (const label of ["Sessions", "Inventory", "Map", "Audit", "Settings"]) {
      expect(nav).toHaveTextContent(label);
    }
  });

  it("explains that it is outside the desktop shell when Tauri is absent", async () => {
    render(<App />);
    expect(await screen.findByTestId("app-version")).toHaveTextContent(
      "Not running inside the Cairn desktop shell.",
    );
  });
});
