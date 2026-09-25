import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../acp/client", () => ({
  acpClient: { prompt: vi.fn(async () => undefined), queuePrompt: vi.fn() },
}));

vi.mock("../../acp/workspace", () => ({
  loadGitStatus: vi.fn(),
}));

import { acpClient } from "../../acp/client";
import { loadGitStatus, type GitStatusSummary } from "../../acp/workspace";
import { emitGitHeadChanged } from "../../state/artifacts";
import { useSessionStore } from "../../state/session";
import { GitChip } from "./git-chip";
import { useGitStatusStore } from "./git-status";

const dirty: GitStatusSummary = {
  isGitRepo: true,
  branch: "main",
  changedFiles: 3,
  additions: 12,
  deletions: 4,
  operationInProgress: false,
};

const clean: GitStatusSummary = { ...dirty, changedFiles: 0, additions: 0, deletions: 0 };

/** Publish a probe answer for the workspace these tests keep open. */
function publishGitStatus(status: GitStatusSummary | null, cwd = "/workspace") {
  useGitStatusStore.setState({ snapshot: status ? { cwd, status } : null });
}

beforeEach(() => {
  publishGitStatus(null);
  vi.mocked(loadGitStatus).mockResolvedValue(dirty);
  vi.mocked(acpClient.prompt).mockClear();
  vi.mocked(acpClient.queuePrompt).mockClear();
  useSessionStore.setState({ cwd: "/workspace", turnRunning: false, notice: null, error: null });
});

afterEach(() => {
  vi.useRealTimers();
  publishGitStatus(null);
  useSessionStore.setState({ cwd: null, turnRunning: false, notice: null, error: null });
});

describe("GitChip", () => {
  it("stays on the header for a clean tree, naming the branch and disabling all actions", async () => {
    vi.mocked(loadGitStatus).mockResolvedValue(clean);
    render(<GitChip />);

    const trigger = await screen.findByTestId("git-chip");
    expect(trigger).toHaveTextContent("main");
    expect(trigger).toHaveAttribute("title", "Clean tree on main");
    expect(screen.queryByTestId("git-chip-count")).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByTestId("git-preview")).toBeDisabled();
    expect(screen.getByTestId("git-commit")).toBeDisabled();
    expect(screen.getByTestId("git-commit-and-push")).toBeDisabled();
  });

  it("says so, with all actions disabled, outside a git repository", async () => {
    vi.mocked(loadGitStatus).mockResolvedValue({ ...clean, isGitRepo: false, branch: null });
    render(<GitChip />);

    const trigger = await screen.findByTestId("git-chip");
    expect(trigger).toHaveTextContent("No git");
    expect(trigger).toHaveAttribute("aria-label", "No git repository");
    expect(trigger).toHaveAttribute("title", "This folder is not a git repository");

    fireEvent.click(trigger);
    expect(screen.getByTestId("git-preview")).toBeDisabled();
    expect(screen.getByTestId("git-commit")).toBeDisabled();
    expect(screen.getByTestId("git-commit")).toHaveTextContent("This folder is not a git repository");
    expect(screen.getByTestId("git-commit-and-push")).toBeDisabled();
  });

  it("waits for a workspace before showing anything", async () => {
    useSessionStore.setState({ cwd: null });
    const { container } = render(<GitChip />);

    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
    expect(container.querySelector(".git-chip")).toBeNull();
  });

  it("shows line totals in the header and the changed-file count in Preview", async () => {
    render(<GitChip />);

    const trigger = await screen.findByTestId("git-chip");
    expect(screen.queryByTestId("git-chip-count")).toBeNull();
    expect(screen.getByTestId("header-diffstat")).toHaveTextContent("12");
    expect(screen.getByTestId("header-diffstat")).toHaveTextContent("4");
    expect(trigger).toHaveAttribute("title", "Workspace changes on main · +12 −4");

    fireEvent.click(trigger);
    expect(screen.getByTestId("git-preview")).toHaveTextContent("3 changed files");
  });

  it("opens the menu on hover and closes it again", async () => {
    render(<GitChip />);

    const trigger = await screen.findByTestId("git-chip");
    expect(screen.queryByTestId("git-chip-menu")).toBeNull();

    fireEvent.mouseEnter(trigger);
    expect(screen.getByTestId("git-chip-menu")).toBeInTheDocument();
    expect(screen.getByTestId("git-preview")).toHaveTextContent("Preview");
    expect(screen.getByTestId("git-commit")).toHaveTextContent("Commit");
    expect(screen.getByTestId("git-commit-and-push")).toHaveTextContent("Commit and push");

    fireEvent.mouseLeave(trigger);
    expect(screen.queryByTestId("git-chip-menu")).toBeNull();
  });

  it("sends /commit when the workspace is idle", async () => {
    render(<GitChip />);

    fireEvent.click(await screen.findByTestId("git-chip"));
    fireEvent.click(screen.getByTestId("git-commit"));

    await waitFor(() => expect(acpClient.prompt).toHaveBeenCalledWith("/commit"));
    expect(acpClient.queuePrompt).not.toHaveBeenCalled();
  });

  it("sends /commit-and-push from the second item", async () => {
    render(<GitChip />);

    fireEvent.click(await screen.findByTestId("git-chip"));
    fireEvent.click(screen.getByTestId("git-commit-and-push"));

    await waitFor(() => expect(acpClient.prompt).toHaveBeenCalledWith("/commit-and-push"));
  });

  it("queues the command instead of prompting while a turn is running", async () => {
    useSessionStore.setState({ turnRunning: true });
    render(<GitChip />);

    fireEvent.click(await screen.findByTestId("git-chip"));
    fireEvent.click(screen.getByTestId("git-commit-and-push"));

    await waitFor(() => expect(acpClient.queuePrompt).toHaveBeenCalledWith("/commit-and-push"));
    expect(acpClient.prompt).not.toHaveBeenCalled();
  });

  it("surfaces an in-progress merge even with nothing staged", async () => {
    vi.mocked(loadGitStatus).mockResolvedValue({ ...clean, operationInProgress: true });
    render(<GitChip />);

    const trigger = await screen.findByTestId("git-chip");
    expect(trigger).toHaveAttribute("title", "Git operation in progress on main");
  });

  it("closes on Escape and re-probes when HEAD moves", async () => {
    render(<GitChip />);

    const trigger = await screen.findByTestId("git-chip");
    fireEvent.click(trigger);
    expect(screen.getByTestId("git-chip-menu")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("git-chip-menu")).toBeNull();

    const calls = vi.mocked(loadGitStatus).mock.calls.length;
    emitGitHeadChanged();
    await waitFor(() => expect(loadGitStatus).toHaveBeenCalledTimes(calls + 1));
  });

  it("answers for the workspace on screen, not the one the window just left", async () => {
    const elsewhere: GitStatusSummary = { ...dirty, branch: "feature/elsewhere" };
    const waiting: Array<(status: GitStatusSummary) => void> = [];
    vi.mocked(loadGitStatus).mockImplementation(
      () => new Promise<GitStatusSummary>((resolve) => waiting.push(resolve)),
    );
    render(<GitChip />);

    await waitFor(() => expect(waiting).toHaveLength(1));
    await act(async () => waiting.shift()!(dirty));
    expect(await screen.findByTestId("git-chip")).toHaveTextContent("main");

    // The conversation list opens a conversation in another project.
    act(() => useSessionStore.setState({ cwd: "/other" }));

    // The branch probed for the folder the window left must not stand in for the new one.
    await waitFor(() => expect(screen.queryByTestId("git-chip")).toBeNull());
    await waitFor(() => expect(waiting).toHaveLength(1));
    await act(async () => waiting.shift()!(elsewhere));

    expect(await screen.findByTestId("git-chip")).toHaveTextContent("feature/elsewhere");
  });
});
