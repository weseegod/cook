import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitStatusSummary } from "../../acp/workspace";
import { useSessionStore, type MessageBlock, type ToolBlock } from "../../state/session";
import { writeLocal } from "../storage";
import { COMPOSER_SHOW_DIFFSTAT_KEY } from "../preferences";
import { ComposerMetricsHost, resetComposerMetricsRuntime, useComposerMetricsStore } from "./composer-rails";
import { useGitStatusStore } from "./git-status";
import { HeaderDiffstat } from "./header-diffstat";

const repo: GitStatusSummary = {
  isGitRepo: true,
  branch: "main",
  changedFiles: 2,
  additions: 12,
  deletions: 4,
  operationInProgress: false,
};

function assistant(text: string, turnId = "turn-1"): MessageBlock {
  return {
    type: "message",
    id: `a-${text.length}`,
    turnId,
    role: "assistant",
    text,
    images: [],
    streaming: false,
  };
}

/** One write tool call carrying the ACP `diff` content the shell sends for an edit: +3 −1. */
function editedFile(turnId: string): ToolBlock {
  return {
    type: "tool",
    id: `tool-${turnId}`,
    turnId,
    title: "Edit src/main.tsx",
    status: "completed",
    content: [{ type: "diff", path: "src/main.tsx", oldText: "a\nb\nc", newText: "a\nX\nY\nZ\nc" }],
    locations: [],
    startedAt: Date.now(),
    elapsedMs: 5,
    paths: ["/workspace/src/main.tsx"],
  };
}

/** The rail plus the metrics host that feeds its no-git fallback, as the header and row mount them. */
function renderRail() {
  return render(
    <>
      <ComposerMetricsHost />
      <HeaderDiffstat />
    </>,
  );
}

/** Publish a probe answer for the workspace these tests keep open. */
function publishGitStatus(status: GitStatusSummary | null, cwd = "/workspace") {
  useGitStatusStore.setState({ snapshot: status ? { cwd, status } : null });
}

beforeEach(() => {
  localStorage.clear();
  resetComposerMetricsRuntime();
  publishGitStatus(repo);
  useSessionStore.setState({
    sessionId: "sess-1",
    cwd: "/workspace",
    blocks: [],
    turnRunning: false,
    activity: null,
    transcriptCursor: { turnId: null, assistantId: null, thoughtId: null, optimisticUserId: null },
  });
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
  });
  resetComposerMetricsRuntime();
  vi.useRealTimers();
  localStorage.clear();
  publishGitStatus(null);
});

describe("header line changes", () => {
  it("shows the working tree totals the git probe published", () => {
    renderRail();

    const rail = screen.getByTestId("header-diffstat");
    expect(rail).toHaveTextContent("12");
    expect(rail).toHaveTextContent("4");
    expect(rail).toHaveAttribute("aria-label", "12 lines added, 4 lines removed");
  });

  it("follows the probe while it is the source of truth", () => {
    renderRail();
    expect(screen.getByTestId("header-diffstat")).toHaveTextContent("12");

    act(() => {
      publishGitStatus({ ...repo, additions: 40, deletions: 9 });
    });

    expect(screen.getByTestId("header-diffstat")).toHaveTextContent("40");
    expect(screen.getByTestId("header-diffstat")).toHaveTextContent("9");
  });

  it("stays away while the tree is clean", () => {
    publishGitStatus({ ...repo, changedFiles: 0, additions: 0, deletions: 0 });
    renderRail();

    expect(screen.queryByTestId("header-diffstat")).toBeNull();
  });

  it("waits for the first probe rather than guessing", () => {
    publishGitStatus(null);
    renderRail();

    expect(screen.queryByTestId("header-diffstat")).toBeNull();
  });

  it("ignores totals probed for the workspace the window is not showing", () => {
    publishGitStatus(repo, "/elsewhere");
    renderRail();

    expect(screen.queryByTestId("header-diffstat")).toBeNull();
  });

  it("hides when the display pref is off", () => {
    writeLocal(COMPOSER_SHOW_DIFFSTAT_KEY, "false");
    renderRail();

    expect(screen.queryByTestId("header-diffstat")).toBeNull();
  });

  it("counts the agent's own edits when the workspace has no git", async () => {
    publishGitStatus({ ...repo, isGitRepo: false, branch: null });
    renderRail();
    expect(screen.queryByTestId("header-diffstat")).toBeNull();

    act(() => {
      useSessionStore.setState({
        turnRunning: true,
        transcriptCursor: { turnId: "turn-1", assistantId: null, thoughtId: null, optimisticUserId: null },
        blocks: [editedFile("turn-1")],
      });
    });
    act(() => {
      useSessionStore.setState({ turnRunning: false });
    });

    const rail = await screen.findByTestId("header-diffstat");
    expect(rail).toHaveTextContent("3");
    expect(rail).toHaveTextContent("1");
  });

  it("prefers the working tree over stale edit totals once git answers", async () => {
    publishGitStatus({ ...repo, isGitRepo: false, branch: null });
    renderRail();

    act(() => {
      useSessionStore.setState({
        turnRunning: true,
        transcriptCursor: { turnId: "turn-1", assistantId: null, thoughtId: null, optimisticUserId: null },
        blocks: [editedFile("turn-1")],
      });
    });
    await waitFor(() => expect(useComposerMetricsStore.getState().diffSource).toBe("edits"));

    act(() => {
      publishGitStatus(repo);
    });

    expect(screen.getByTestId("header-diffstat")).toHaveAttribute(
      "aria-label",
      "12 lines added, 4 lines removed",
    );
  });

  it("does not carry a chat-only turn into the rail", async () => {
    publishGitStatus({ ...repo, isGitRepo: false, branch: null });
    renderRail();

    act(() => {
      useSessionStore.setState({
        turnRunning: true,
        transcriptCursor: { turnId: "turn-1", assistantId: "a1", thoughtId: null, optimisticUserId: null },
        blocks: [assistant("no edits here")],
      });
    });
    act(() => {
      useSessionStore.setState({ turnRunning: false });
    });

    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
    expect(screen.queryByTestId("header-diffstat")).toBeNull();
  });
});
