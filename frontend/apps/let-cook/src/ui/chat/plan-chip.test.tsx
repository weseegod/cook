import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../acp/client", () => ({
  acpClient: { refreshPlanFiles: vi.fn(async () => undefined) },
}));
vi.mock("../../acp/plan-files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../acp/plan-files")>()),
  deletePlanFile: vi.fn(async () => true),
}));
vi.mock("./clipboard", () => ({ copyText: vi.fn(async () => undefined) }));

import { acpClient } from "../../acp/client";
import { deletePlanFile, type PlanFileSummary } from "../../acp/plan-files";
import { useSessionStore } from "../../state/session";
import { copyText } from "./clipboard";
import { PlanChip } from "./plan-chip";

const PLANS = "/home/u/.cook/sessions/p/sess-1/plans";

function planFile(overrides: Partial<PlanFileSummary> = {}): PlanFileSummary {
  return {
    name: "2026-09-19T14-30-22Z.md",
    title: "Current plan",
    path: `${PLANS}/2026-09-19T14-30-22Z.md`,
    relativePath: "plans/2026-09-19T14-30-22Z.md",
    sizeBytes: 1368,
    modifiedMs: Date.parse("2026-09-19T14:30:22Z"),
    active: true,
    deletable: false,
    content: "# Current plan",
    ...overrides,
  };
}

const OLDER = planFile({
  name: "2026-09-18T09-15-00Z.md",
  title: "First plan",
  path: `${PLANS}/2026-09-18T09-15-00Z.md`,
  relativePath: "plans/2026-09-18T09-15-00Z.md",
  sizeBytes: 804,
  active: false,
  deletable: true,
  content: "# First plan",
});

beforeEach(() => {
  vi.mocked(copyText).mockClear();
  vi.mocked(deletePlanFile).mockClear();
  vi.mocked(acpClient.refreshPlanFiles).mockClear();
  useSessionStore.setState({
    planFiles: [],
    planFileView: null,
    planReview: null,
    planDialogOpen: false,
    cwd: "/work",
    sessionId: "sess-1",
    notice: null,
    error: null,
  });
});

afterEach(cleanup);

describe("PlanChip", () => {
  it("stays in the header for every conversation and lists nothing yet", () => {
    render(<PlanChip />);

    const chip = screen.getByTestId("plan-chip");
    expect(chip).toHaveTextContent("Plans");
    expect(screen.getByTestId("plan-chip-count")).toHaveTextContent("0");

    fireEvent.click(chip);
    expect(screen.getByTestId("plan-menu-empty")).toHaveTextContent("No plans in this conversation yet");
    expect(document.querySelectorAll(".plan-menu-row")).toHaveLength(0);
  });

  it("leaves the welcome screen without a workspace alone", () => {
    useSessionStore.setState({ cwd: null });
    render(<PlanChip />);

    expect(screen.queryByTestId("plan-chip")).toBeNull();
  });

  it("counts the conversation's plans and names the current episode in the tooltip", () => {
    useSessionStore.setState({ planFiles: [planFile(), OLDER] });
    render(<PlanChip />);

    expect(screen.getByTestId("plan-chip")).toHaveTextContent("Plans");
    expect(screen.getByTestId("plan-chip-count")).toHaveTextContent("2");
    expect(screen.getByTestId("plan-chip")).toHaveAttribute("title", expect.stringContaining("Current plan"));
    fireEvent.click(screen.getByTestId("plan-chip"));

    expect(screen.getByTestId(`plan-file-row-${OLDER.name}`)).toHaveTextContent("804 B");
    // Exactly one row is the session's current episode.
    expect(screen.getAllByTestId("plan-file-current")).toHaveLength(1);
    expect(screen.getByTestId(`plan-file-row-${planFile().name}`).className).toContain("active");
  });

  it("lists again when the menu opens", () => {
    useSessionStore.setState({ planFiles: [planFile()] });
    render(<PlanChip />);

    fireEvent.click(screen.getByTestId("plan-chip"));

    expect(vi.mocked(acpClient.refreshPlanFiles)).toHaveBeenCalledTimes(1);
  });

  it("keeps the older behavior when the agent serves no list", () => {
    useSessionStore.setState({ planReview: { body: "# Plan", fileName: "plan.md", pending: true } });
    render(<PlanChip />);

    fireEvent.click(screen.getByTestId("plan-chip"));

    expect(screen.queryByTestId("plan-menu")).toBeNull();
    expect(useSessionStore.getState().planDialogOpen).toBe(true);
  });

  it("hides the row actions behind hover and opens the row menu", () => {
    useSessionStore.setState({ planFiles: [planFile(), OLDER] });
    render(<PlanChip />);
    fireEvent.click(screen.getByTestId("plan-chip"));

    const dots = screen.getByTestId(`plan-file-actions-${OLDER.name}`);
    expect(dots).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(dots);

    expect(screen.getByTestId(`plan-file-menu-${OLDER.name}`)).toBeInTheDocument();
    expect(screen.getByTestId("plan-file-copy")).toHaveTextContent("Copy");
    expect(screen.getByTestId("plan-file-copy-path")).toHaveTextContent("Copy file path");
    expect(screen.getByTestId("plan-file-delete")).toHaveClass("plan-row-menu-danger");
  });

  it("refuses to delete the file the running episode holds", () => {
    useSessionStore.setState({ planFiles: [planFile()] });
    render(<PlanChip />);
    fireEvent.click(screen.getByTestId("plan-chip"));
    fireEvent.click(screen.getByTestId(`plan-file-actions-${planFile().name}`));

    const remove = screen.getByTestId("plan-file-delete");
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute("title", expect.stringContaining("current plan cannot be deleted"));
  });

  it("copies the plan body and the absolute path", async () => {
    useSessionStore.setState({ planFiles: [planFile(), OLDER] });
    render(<PlanChip />);
    fireEvent.click(screen.getByTestId("plan-chip"));

    fireEvent.click(screen.getByTestId(`plan-file-actions-${OLDER.name}`));
    fireEvent.click(screen.getByTestId("plan-file-copy"));
    await vi.waitFor(() => expect(vi.mocked(copyText)).toHaveBeenCalledWith("# First plan"));
    expect(useSessionStore.getState().notice).toBe(`Copied ${OLDER.name}`);

    fireEvent.click(screen.getByTestId(`plan-file-actions-${OLDER.name}`));
    fireEvent.click(screen.getByTestId("plan-file-copy-path"));
    await vi.waitFor(() => expect(vi.mocked(copyText)).toHaveBeenLastCalledWith(OLDER.path));
    expect(useSessionStore.getState().notice).toBe(`Copied ${OLDER.path}`);
  });

  it("reports a plan the agent withheld because it is too large", () => {
    useSessionStore.setState({ planFiles: [planFile({ name: "big.md", content: null }), OLDER] });
    render(<PlanChip />);
    fireEvent.click(screen.getByTestId("plan-chip"));

    fireEvent.click(screen.getByTestId("plan-file-actions-big.md"));
    fireEvent.click(screen.getByTestId("plan-file-copy"));

    expect(vi.mocked(copyText)).not.toHaveBeenCalled();
    expect(useSessionStore.getState().notice).toBe("big.md is too large to copy from here. Open it instead.");
  });

  it("opens the current episode's review and an earlier plan read-only", () => {
    useSessionStore.setState({ planFiles: [planFile(), OLDER] });
    render(<PlanChip />);

    fireEvent.click(screen.getByTestId("plan-chip"));
    fireEvent.click(screen.getByTestId(`plan-file-open-${OLDER.name}`));
    expect(useSessionStore.getState().planFileView?.name).toBe(OLDER.name);
    expect(useSessionStore.getState().planDialogOpen).toBe(false);

    fireEvent.click(screen.getByTestId("plan-chip"));
    fireEvent.click(screen.getByTestId(`plan-file-open-${planFile().name}`));
    // No parked review here, so the current episode opens read-only too.
    expect(useSessionStore.getState().planFileView?.name).toBe(planFile().name);
  });

  it("reopens the decision bar for a hidden pending review while an older file stays read-only", () => {
    const current = planFile();
    useSessionStore.setState({
      planFiles: [current, OLDER],
      planReview: { body: "# Plan", fileName: current.name, pending: true },
      planDialogOpen: false,
      planFileView: null,
    });
    render(<PlanChip />);

    fireEvent.click(screen.getByTestId("plan-chip"));
    fireEvent.click(screen.getByTestId(`plan-file-open-${current.name}`));
    expect(useSessionStore.getState().planDialogOpen).toBe(true);
    expect(useSessionStore.getState().planFileView).toBeNull();

    useSessionStore.setState({ planDialogOpen: false });
    fireEvent.click(screen.getByTestId("plan-chip"));
    fireEvent.click(screen.getByTestId(`plan-file-open-${OLDER.name}`));
    expect(useSessionStore.getState().planFileView?.name).toBe(OLDER.name);
    expect(useSessionStore.getState().planDialogOpen).toBe(false);
  });

  it("opens the waiting file read-only once a decision was sent", () => {
    const current = planFile();
    useSessionStore.setState({
      planFiles: [current],
      planReview: { body: "# Plan", fileName: current.name, pending: false },
      planDialogOpen: false,
    });
    render(<PlanChip />);

    fireEvent.click(screen.getByTestId("plan-chip"));
    fireEvent.click(screen.getByTestId(`plan-file-open-${current.name}`));
    expect(useSessionStore.getState().planFileView?.name).toBe(current.name);
    expect(useSessionStore.getState().planDialogOpen).toBe(false);
  });

  it("deletes an earlier plan once the confirmation is accepted", async () => {
    useSessionStore.setState({ planFiles: [planFile(), OLDER], planDialogOpen: false });
    render(<PlanChip />);
    fireEvent.click(screen.getByTestId("plan-chip"));
    fireEvent.click(screen.getByTestId(`plan-file-actions-${OLDER.name}`));
    fireEvent.click(screen.getByTestId("plan-file-delete"));

    expect(screen.getByRole("dialog")).toHaveTextContent(`Delete ${OLDER.name}?`);
    fireEvent.click(screen.getByTestId("plan-delete-confirm"));

    await vi.waitFor(() => expect(vi.mocked(deletePlanFile)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(deletePlanFile)).toHaveBeenCalledWith({ sessionId: "sess-1", cwd: "/work", path: OLDER.path });
    await vi.waitFor(() => expect(vi.mocked(acpClient.refreshPlanFiles)).toHaveBeenCalled());
    expect(useSessionStore.getState().notice).toBe(`Deleted ${OLDER.name}`);
  });
});
