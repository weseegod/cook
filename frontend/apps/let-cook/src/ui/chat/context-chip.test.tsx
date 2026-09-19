import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../acp/client", () => ({
  acpClient: { prompt: vi.fn(async () => undefined), queuePrompt: vi.fn() },
}));

import { useSessionStore } from "../../state/session";
import { ContextChip } from "./context-chip";

beforeEach(() => {
  useSessionStore.setState({ usage: null });
});

afterEach(() => {
  useSessionStore.setState({ usage: null });
});

describe("ContextChip", () => {
  it("replaces the token count with a TUI-style meter on hover", () => {
    useSessionStore.setState({ usage: { used: 420_000, size: 1_000_000 } });
    render(<ContextChip />);

    const trigger = screen.getByTestId("context-chip");
    expect(trigger).toHaveTextContent("420K / 1.0M");
    expect(screen.queryByTestId("context-chip-percent")).toBeNull();

    fireEvent.mouseEnter(trigger);

    expect(screen.getByTestId("context-chip-percent")).toHaveTextContent("42.0%");
    expect(screen.getByTestId("context-chip-meter")).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByTestId("context-chip-meter")).toHaveAttribute("data-tone", "normal");
    expect(screen.getByTestId("context-chip-meter")).toHaveStyle({ width: "5ch" });
    expect(screen.getByTestId("context-chip-meter-fill")).toHaveStyle({ width: "42%" });

    fireEvent.mouseLeave(trigger);
    expect(screen.queryByTestId("context-chip-percent")).toBeNull();
    expect(trigger).toHaveTextContent("420K / 1.0M");
  });

  it("uses the TUI max label when usage reaches the context limit", () => {
    useSessionStore.setState({ usage: { used: 1_100, size: 1_000 } });
    render(<ContextChip />);

    fireEvent.mouseEnter(screen.getByTestId("context-chip"));

    expect(screen.getByTestId("context-chip-percent")).toHaveTextContent("MAX %");
    expect(screen.getByTestId("context-chip-meter-fill")).toHaveStyle({ width: "100%" });
    expect(screen.getByTestId("context-chip-meter-fill")).toHaveAttribute("data-tone", "danger");
  });
});
