import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const dirty: GitStatusSummary = {
  isGitRepo: true,
  branch: "main",
  changedFiles: 3,
  additions: 12,
  deletions: 4,
  operationInProgress: false,
};

const clean: GitStatusSummary = { ...dirty, changedFiles: 0, additions: 0, deletions: 0 };

beforeEach(() => {
  vi.mocked(loadGitStatus).mockResolvedValue(dirty);
  vi.mocked(acpClient.prompt).mockClear();
  vi.mocked(acpClient.queuePrompt).mockClear();
  useSessionStore.setState({ cwd: "/workspace", turnRunning: false, notice: null, error: null });
});

afterEach(() => {
  vi.useRealTimers();
  useSessionStore.setState({ cwd: null, turnRunning: false, notice: null, error: null });
});

describe("GitChip", () => {
  it("stays hidden while the tree is clean or not a git repo", async () => {
    vi.mocked(loadGitStatus).mockResolvedValue(clean);
    const { container } = render(<GitChip />);

    await waitFor(() => expect(loadGitStatus).toHaveBeenCalled());
    expect(container.querySelector(".git-chip")).toBeNull();
  });

  it("shows the change count and a branch/diff summary", async () => {
    render(<GitChip />);

    const trigger = await screen.findByTestId("git-chip");
    expect(screen.getByTestId("git-chip-count")).toHaveTextContent("3");
    expect(trigger).toHaveAttribute("title", "3 changed files on main · +12 −4");
  });

  it("opens the menu on hover and closes it again", async () => {
    render(<GitChip />);

    const trigger = await screen.findByTestId("git-chip");
    expect(screen.queryByTestId("git-chip-menu")).toBeNull();

    fireEvent.mouseEnter(trigger);
    expect(screen.getByTestId("git-chip-menu")).toBeInTheDocument();
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
});
