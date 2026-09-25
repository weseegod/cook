import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../acp/client", () => ({
  acpClient: {
    prompt: vi.fn(async () => undefined),
    queuePrompt: vi.fn(),
    connect: vi.fn(async () => undefined),
  },
}));

vi.mock("../../acp/host", () => ({ pickFolder: vi.fn(async () => null) }));

vi.mock("../../acp/workspace", () => ({ loadGitStatus: vi.fn() }));

import { loadGitStatus, type GitStatusSummary } from "../../acp/workspace";
import { useSessionStore } from "../../state/session";
import { useToolsPanelStore } from "../../state/tools-panel";
import { AgentHeader } from "./agent-header";
import { useGitStatusStore } from "./git-status";

const dirty: GitStatusSummary = {
  isGitRepo: true,
  branch: "main",
  changedFiles: 2,
  additions: 9,
  deletions: 3,
  operationInProgress: false,
};

function renderHeader() {
  return render(
    <AgentHeader
      sidebarOpen
      onToggleSidebar={() => {}}
      utilityPanelOpen
      onOpenTools={() => {}}
    />,
  );
}

/** Publish a probe answer for the workspace these tests keep open. */
function publishGitStatus(status: GitStatusSummary | null, cwd = "/workspace") {
  useGitStatusStore.setState({ snapshot: status ? { cwd, status } : null });
}

beforeEach(() => {
  publishGitStatus(null);
  useToolsPanelStore.setState({ nonce: 0, target: null });
  useSessionStore.setState({
    cwd: "/workspace",
    blocks: [],
    goal: null,
    planEntries: [],
    todoOverlayOpen: false,
    usage: null,
    turnRunning: false,
  });
});

afterEach(() => {
  publishGitStatus(null);
  useToolsPanelStore.setState({ nonce: 0, target: null });
  useSessionStore.setState({ cwd: null, blocks: [], goal: null, planEntries: [], todoOverlayOpen: false });
});

describe("AgentHeader git chip", () => {
  it("mounts the chip inside the header's right cluster when the tree is dirty", async () => {
    vi.mocked(loadGitStatus).mockResolvedValue(dirty);
    renderHeader();

    const chip = await screen.findByTestId("git-chip");
    expect(screen.getByTestId("agent-header")).toContainElement(chip);
    expect(screen.getByTestId("header-diffstat")).toHaveTextContent("9");
    expect(screen.queryByTestId("git-chip-count")).toBeNull();
  });

  it("keeps the chip for a clean tree and leaves the rest of the header alone", async () => {
    vi.mocked(loadGitStatus).mockResolvedValue({
      ...dirty,
      changedFiles: 0,
      additions: 0,
      deletions: 0,
    });
    renderHeader();

    const chip = await screen.findByTestId("git-chip");
    expect(chip).toHaveTextContent("main");
    expect(screen.queryByTestId("git-chip-count")).toBeNull();
    // The rest of the header still renders: the chip is additive, not a replacement.
    expect(screen.getByTestId("agent-header")).toBeInTheDocument();
    expect(screen.queryByTestId("context-chip")).toBeNull();
  });

  it("keeps the chip, saying the folder has no repository, outside a git repository", async () => {
    vi.mocked(loadGitStatus).mockResolvedValue({ ...dirty, isGitRepo: false, branch: null });
    renderHeader();

    const chip = await screen.findByTestId("git-chip");
    expect(chip).toHaveTextContent("No git");
    expect(screen.queryByTestId("context-chip")).toBeNull();
  });
});

describe("AgentHeader layout", () => {
  it("carries the plans on the left and combines git state with line changes on the right", async () => {
    vi.mocked(loadGitStatus).mockResolvedValue(dirty);
    renderHeader();

    const chip = await screen.findByTestId("git-chip");
    const diffstat = screen.getByTestId("header-diffstat");
    expect(screen.getByTestId("plan-chip").closest(".agent-header-left")).not.toBeNull();
    expect(chip.closest(".agent-header-right")).not.toBeNull();
    expect(chip).toContainElement(diffstat);
    const branch = chip.querySelector(".git-chip-branch")!;
    expect(branch.compareDocumentPosition(diffstat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chip.querySelector(".git-chip-count")).toBeNull();
  });

  it("reserves stable slots for optional header controls", () => {
    renderHeader();

    const slots = Array.from(document.querySelectorAll(".agent-header-right > .agent-header-slot"));
    expect(slots.map((slot) => slot.className)).toEqual([
      "agent-header-slot agent-header-slot-goal agent-header-slot-goal-empty",
      "agent-header-slot agent-header-slot-git",
      "agent-header-slot agent-header-slot-tools",
    ]);
  });

  it("shows the checklist chip with completed progress when a plan exists without a goal", () => {
    useSessionStore.setState({
      planEntries: [
        { content: "Done", status: "completed" },
        { content: "In progress", status: "in_progress" },
        { content: "Pending", status: "pending" },
      ],
    });
    renderHeader();

    const chip = screen.getByTestId("todo-toggle");
    expect(chip).toHaveTextContent("Checklist");
    expect(screen.getByTestId("todo-chip-count")).toHaveTextContent("1/3");
    expect(chip.closest(".agent-header-slot")).toHaveClass("agent-header-slot-goal-checklist");
  });

  it("opens the Review panel from the Git chip Preview action", async () => {
    vi.mocked(loadGitStatus).mockResolvedValue(dirty);
    renderHeader();

    fireEvent.click(await screen.findByTestId("git-chip"));
    fireEvent.click(screen.getByTestId("git-preview"));
    expect(useToolsPanelStore.getState().target).toBe("review");
    expect(useToolsPanelStore.getState().nonce).toBe(1);
  });

  it("probes the shared snapshot once for the chip and the line changes", async () => {
    vi.mocked(loadGitStatus).mockResolvedValue(dirty);
    const before = vi.mocked(loadGitStatus).mock.calls.length;
    renderHeader();

    await screen.findByTestId("header-diffstat");
    await screen.findByTestId("git-chip");
    expect(vi.mocked(loadGitStatus).mock.calls.length).toBe(before + 1);
  });
});
