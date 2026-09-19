import { render, screen, waitFor } from "@testing-library/react";
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
import { AgentHeader } from "./agent-header";

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

beforeEach(() => {
  useSessionStore.setState({ cwd: "/workspace", blocks: [], usage: null, turnRunning: false });
});

afterEach(() => {
  useSessionStore.setState({ cwd: null, blocks: [] });
});

describe("AgentHeader git chip", () => {
  it("mounts the chip inside the header's right cluster when the tree is dirty", async () => {
    vi.mocked(loadGitStatus).mockResolvedValue(dirty);
    renderHeader();

    const chip = await screen.findByTestId("git-chip");
    expect(screen.getByTestId("agent-header")).toContainElement(chip);
    expect(screen.getByTestId("git-chip-count")).toHaveTextContent("2");
  });

  it("leaves the header untouched while the tree is clean", async () => {
    vi.mocked(loadGitStatus).mockResolvedValue({
      ...dirty,
      changedFiles: 0,
      additions: 0,
      deletions: 0,
    });
    renderHeader();

    await waitFor(() => expect(loadGitStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("git-chip")).toBeNull();
    // The rest of the header still renders: the chip is additive, not a replacement.
    expect(screen.getByTestId("agent-header")).toBeInTheDocument();
    expect(screen.getByTestId("context-chip")).toBeInTheDocument();
  });
});
