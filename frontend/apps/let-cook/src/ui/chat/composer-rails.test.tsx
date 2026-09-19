import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitStatusSummary } from "../../acp/workspace";
import { useSessionStore, type MessageBlock, type ToolBlock } from "../../state/session";
import { writeLocal } from "../storage";
import { COMPOSER_SHOW_DIFFSTAT_KEY, COMPOSER_SHOW_TPS_KEY } from "../preferences";
import {
  ComposerMetricsHost,
  ComposerTpsRail,
  resetComposerMetricsRuntime,
  useComposerMetricsStore,
} from "./composer-rails";
import { useGitStatusStore } from "./git-status";

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

function thought(text: string, turnId = "turn-1"): MessageBlock {
  return {
    type: "message",
    id: `t-${text.length}`,
    turnId,
    role: "thought",
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

function renderRails() {
  return render(
    <>
      <ComposerMetricsHost />
      <ComposerTpsRail />
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
  useComposerMetricsStore.getState().clear();
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
  // Flush deferred host teardown from useComposerMetrics.
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
  });
  resetComposerMetricsRuntime();
  vi.useRealTimers();
  localStorage.clear();
  publishGitStatus(null);
  useComposerMetricsStore.getState().clear();
});

describe("composer rails", () => {
  it("shows no t/s before a turn", () => {
    renderRails();
    expect(screen.queryByTestId("turn-status-tps")).toBeNull();
  });

  it("hides when the pref is off", async () => {
    writeLocal(COMPOSER_SHOW_TPS_KEY, "false");
    writeLocal(COMPOSER_SHOW_DIFFSTAT_KEY, "false");
    renderRails();

    act(() => {
      useSessionStore.setState({
        turnRunning: true,
        transcriptCursor: { turnId: "turn-1", assistantId: "a1", thoughtId: null, optimisticUserId: null },
        activity: { kind: "responding" },
      });
    });
    act(() => {
      useSessionStore.setState({
        turnRunning: false,
        activity: null,
        blocks: [assistant("abcdefghij")],
      });
    });

    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
    expect(screen.queryByTestId("turn-status-tps")).toBeNull();
    // Nothing measured, so the header's fallback line changes stay empty too.
    expect(useComposerMetricsStore.getState().diffSource).toBeNull();
  });

  it("shows t/s after finishTurn with assistant text and a decode window", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderRails();

    act(() => {
      useSessionStore.setState({
        turnRunning: true,
        transcriptCursor: { turnId: "turn-1", assistantId: "a1", thoughtId: null, optimisticUserId: null },
        activity: { kind: "thinking" },
        blocks: [thought("plan")],
      });
    });
    act(() => {
      useSessionStore.setState({ activity: { kind: "responding" } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    act(() => {
      useSessionStore.setState({
        turnRunning: false,
        activity: null,
        blocks: [thought("plan"), assistant("a".repeat(170))],
      });
    });

    expect(await screen.findByTestId("turn-status-tps")).toHaveTextContent(/t\/s/);
    expect(screen.getByTestId("turn-status-tps").getAttribute("aria-label")).toMatch(
      /tokens per second/,
    );
  });

  it("shows a live t/s one sample into the turn, counting thinking as well as prose", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderRails();

    act(() => {
      useSessionStore.setState({
        turnRunning: true,
        transcriptCursor: { turnId: "turn-1", assistantId: null, thoughtId: "t1", optimisticUserId: null },
        activity: { kind: "thinking" },
        blocks: [thought("t".repeat(200))],
      });
    });

    // The reading lands on the sample interval, not on the spinner frame.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.queryByTestId("turn-status-tps")).toBeNull();

    act(() => {
      useSessionStore.setState({ blocks: [thought("t".repeat(200)), assistant("a".repeat(200))] });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    // 50 more tokens decoded across the 1.5s sample window: 200 thinking + 200 prose chars at the
    // 4-chars-per-token estimate.
    expect(screen.getByTestId("turn-status-tps")).toHaveTextContent("33.3");
  });

  it("leaves the edit fallback alone in a repository, where the header probe owns the numbers", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderRails();

    act(() => {
      useSessionStore.setState({
        turnRunning: true,
        transcriptCursor: { turnId: "turn-1", assistantId: null, thoughtId: null, optimisticUserId: null },
        blocks: [editedFile("turn-1")],
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    act(() => {
      useSessionStore.setState({ turnRunning: false });
    });

    expect(useComposerMetricsStore.getState().diffSource).toBeNull();
  });

  it("counts the agent's own edits when the workspace has no git", async () => {
    publishGitStatus({ ...repo, isGitRepo: false, branch: null });
    renderRails();

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

    await waitFor(() => expect(useComposerMetricsStore.getState().diffSource).toBe("edits"));
    expect(useComposerMetricsStore.getState()).toMatchObject({ additions: 3, deletions: 1 });
  });

  it("clears the rate on session reset", async () => {
    renderRails();
    act(() => {
      useComposerMetricsStore.getState().setTps(42);
    });
    expect(screen.getByTestId("turn-status-tps")).toHaveTextContent("42.0");

    act(() => {
      useSessionStore.getState().resetConversation("sess-2");
    });

    await waitFor(() => expect(screen.queryByTestId("turn-status-tps")).toBeNull());
  });

  it("shows t/s when the model only streams thinking then a short reply", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderRails();

    act(() => {
      useSessionStore.setState({
        turnRunning: true,
        transcriptCursor: { turnId: "turn-1", assistantId: "a1", thoughtId: null, optimisticUserId: null },
        activity: { kind: "thinking" },
        blocks: [thought("plan")],
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    act(() => {
      useSessionStore.setState({
        turnRunning: false,
        activity: null,
        blocks: [thought("plan"), assistant("a".repeat(80))],
      });
    });

    expect(await screen.findByTestId("turn-status-tps")).toHaveTextContent(/t\/s/);
  });
});
