import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./clipboard", () => ({ copyText: vi.fn(async () => undefined) }));

import type { PlanFileSummary } from "../../acp/plan-files";
import { useSessionStore } from "../../state/session";
import { copyText } from "./clipboard";
import { PlanFileDialog } from "./plan-file-dialog";

const PLANS = "/home/u/.cook/sessions/p/sess-1/plans";

function planFile(overrides: Partial<PlanFileSummary> = {}): PlanFileSummary {
  return {
    name: "2026-09-18T09-15-00Z.md",
    title: "First plan",
    path: `${PLANS}/2026-09-18T09-15-00Z.md`,
    relativePath: "plans/2026-09-18T09-15-00Z.md",
    sizeBytes: 804,
    modifiedMs: Date.parse("2026-09-18T09:15:00Z"),
    active: false,
    deletable: true,
    content: "# First plan\n\nDo the work.",
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(copyText).mockClear();
  useSessionStore.setState({
    planFileView: null,
    notice: null,
    error: null,
  });
});

afterEach(() => cleanup());

describe("PlanFileDialog", () => {
  it("offers Copy and Copy file path for a read-only plan", async () => {
    const file = planFile();
    useSessionStore.setState({ planFileView: file });
    render(<PlanFileDialog />);

    expect(screen.getByTestId("plan-file-view-copy")).toHaveTextContent("Copy");
    expect(screen.getByTestId("plan-file-view-copy-path")).toHaveTextContent("Copy file path");

    fireEvent.click(screen.getByTestId("plan-file-view-copy"));
    await vi.waitFor(() => expect(vi.mocked(copyText)).toHaveBeenCalledWith(file.content));
    expect(useSessionStore.getState().notice).toBe(`Copied ${file.name}`);

    fireEvent.click(screen.getByTestId("plan-file-view-copy-path"));
    await vi.waitFor(() => expect(vi.mocked(copyText)).toHaveBeenLastCalledWith(file.path));
    expect(useSessionStore.getState().notice).toBe(`Copied ${file.path}`);
  });

  it("offers the same actions when the current episode opens read-only", async () => {
    const file = planFile({
      name: "2026-09-19T14-30-22Z.md",
      title: "Current plan",
      path: `${PLANS}/2026-09-19T14-30-22Z.md`,
      relativePath: "plans/2026-09-19T14-30-22Z.md",
      active: true,
      deletable: false,
      content: "# Current plan",
    });
    useSessionStore.setState({ planFileView: file });
    render(<PlanFileDialog />);

    fireEvent.click(screen.getByTestId("plan-file-view-copy"));
    await vi.waitFor(() => expect(vi.mocked(copyText)).toHaveBeenCalledWith("# Current plan"));
    fireEvent.click(screen.getByTestId("plan-file-view-copy-path"));
    await vi.waitFor(() => expect(vi.mocked(copyText)).toHaveBeenLastCalledWith(file.path));
  });

  it("disables Copy when the body was withheld", () => {
    useSessionStore.setState({ planFileView: planFile({ content: null, name: "big.md" }) });
    render(<PlanFileDialog />);

    expect(screen.getByTestId("plan-file-view-copy")).toBeDisabled();
    expect(screen.getByTestId("plan-file-view-copy-path")).toBeEnabled();
  });
});
