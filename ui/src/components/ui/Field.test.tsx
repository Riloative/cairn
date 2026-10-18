import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Field } from "./Field";
import { Input } from "./Input";

describe("Field", () => {
  it("labels the control and links the description", () => {
    render(
      <Field label="Hostname" description="Short name">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText("Hostname");
    expect(input).toHaveAccessibleDescription("Short name");
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("marks the control invalid and announces the error", () => {
    render(
      <Field label="IP" description="IPv4 or IPv6" error="Not a valid IP address">
        <Input />
      </Field>,
    );
    expect(screen.getByLabelText("IP")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Not a valid IP address");
  });
});
