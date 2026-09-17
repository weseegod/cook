import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToggleSwitch } from "./toggle-switch";

describe("ToggleSwitch", () => {
  it("keeps a semantic checkbox while exposing the macOS switch control", () => {
    const onChange = vi.fn();
    render(<ToggleSwitch checked={false} ariaLabel="Plan mode" onChange={onChange} />);

    const control = screen.getByRole("checkbox", { name: "Plan mode" });
    expect(control).not.toBeChecked();
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("does not allow disabled switches to be changed", () => {
    const onChange = vi.fn();
    render(<ToggleSwitch checked={true} ariaLabel="Always approve" onChange={onChange} disabled />);

    const control = screen.getByRole("checkbox", { name: "Always approve" });
    expect(control).toBeDisabled();
    fireEvent.click(control);
    expect(onChange).not.toHaveBeenCalled();
  });
});
