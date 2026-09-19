import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../acp/workspace", () => ({
  loadGitStatus: vi.fn(),
}));

import { loadGitStatus, type GitStatusSummary } from "../../acp/workspace";
import { emitGitHeadChanged } from "../../state/artifacts";
import { useSessionStore, type MessageBlock } from "../../state/session";
import { writeLocal } from "../storage";
import {
  COMPOSER_SHOW_DIFFSTAT_KEY,
  COMPOSER_SHOW_TPS_KEY,
} from "../preferences";
import {
  ComposerDiffstatRail,
  ComposerMetricsHost,
  ComposerTpsRail,
  resetComposerMetricsRuntime,
  useComposerMetricsStore,
} from "./composer-rails";

const dirty: GitStatusSummary = {
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

function renderRails() {
  return render(
    <>
      <ComposerMetricsHost />
      <ComposerTpsRail />
      <ComposerDiffstatRail />
    </>,
  );
}

beforeEach(() => {
  localStorage.clear();
  resetComposerMetricsRuntime();
  vi.mocked(loadGitStatus).mockReset();
  vi.mocked(loadGitStatus).mockResolvedValue(dirty);
  useComposerMetricsStore.getState().clear();
  useSessionStore.setState({
    sessionId: "sess-1",
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
  useComposerMetricsStore.getState().clear();
});

describe("composer rails", () => {
  it("shows dirty-tree diffstat before a turn once snapshotted, but not TPS", async () => {
    renderRails();
    expect(screen.queryByTestId("turn-status-tps")).toBeNull();
    expect(await screen.findByTestId("turn-status-diffstat")).toHaveTextContent("12");
  });

  it("hides when prefs are false", async () => {
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

    await waitFor(() => expect(loadGitStatus).not.toHaveBeenCalled());
    expect(screen.queryByTestId("turn-status-tps")).toBeNull();
    expect(screen.queryByTestId("turn-status-diffstat")).toBeNull();
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

  it("fetches git on mount and again at turn end, then renders +N −M", async () => {
    renderRails();
    await waitFor(() => expect(loadGitStatus).toHaveBeenCalledTimes(1));

    act(() => {
      useSessionStore.setState({
        turnRunning: true,
        transcriptCursor: { turnId: "turn-1", assistantId: "a1", thoughtId: null, optimisticUserId: null },
      });
    });
    act(() => {
      useSessionStore.setState({ turnRunning: false, blocks: [assistant("abcd")] });
    });

    await waitFor(() => expect(loadGitStatus).toHaveBeenCalledTimes(2));
    const rail = await screen.findByTestId("turn-status-diffstat");
    expect(rail).toHaveTextContent("12");
    expect(rail).toHaveTextContent("4");
    expect(rail).toHaveAttribute("aria-label", "12 lines added, 4 lines removed");
  });

  it("hides +0 −0", async () => {
    vi.mocked(loadGitStatus).mockResolvedValue({ ...dirty, additions: 0, deletions: 0, changedFiles: 0 });
    renderRails();

    act(() => {
      useSessionStore.setState({
        turnRunning: true,
        transcriptCursor: { turnId: "turn-1", assistantId: "a1", thoughtId: null, optimisticUserId: null },
      });
    });
    act(() => {
      useSessionStore.setState({ turnRunning: false });
    });

    await waitFor(() => expect(loadGitStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("turn-status-diffstat")).toBeNull();
  });

  it("freezes displayed numbers while the turn is running", async () => {
    renderRails();
    await screen.findByTestId("turn-status-diffstat");
    const callsAfterMount = vi.mocked(loadGitStatus).mock.calls.length;

    act(() => {
      useSessionStore.setState({
        turnRunning: true,
        transcriptCursor: { turnId: "turn-1", assistantId: "a1", thoughtId: null, optimisticUserId: null },
      });
    });
    act(() => {
      useSessionStore.setState({ turnRunning: false });
    });
    await waitFor(() => expect(loadGitStatus).toHaveBeenCalledTimes(callsAfterMount + 1));

    vi.mocked(loadGitStatus).mockResolvedValue({ ...dirty, additions: 99, deletions: 88 });
    act(() => {
      useSessionStore.setState({
        turnRunning: true,
        transcriptCursor: { turnId: "turn-2", assistantId: "a2", thoughtId: null, optimisticUserId: null },
      });
    });

    expect(screen.getByTestId("turn-status-diffstat")).toHaveTextContent("12");
    expect(screen.getByTestId("turn-status-diffstat")).toHaveTextContent("4");
    expect(loadGitStatus).toHaveBeenCalledTimes(callsAfterMount + 1);
  });

  it("clears both rails on session reset", async () => {
    renderRails();

    act(() => {
      useSessionStore.setState({
        turnRunning: true,
        transcriptCursor: { turnId: "turn-1", assistantId: "a1", thoughtId: null, optimisticUserId: null },
      });
    });
    act(() => {
      useSessionStore.setState({ turnRunning: false, blocks: [assistant("abcdefghij")] });
    });
    await screen.findByTestId("turn-status-diffstat");

    act(() => {
      useSessionStore.getState().resetConversation("sess-2");
    });

    await waitFor(() => {
      expect(screen.queryByTestId("turn-status-tps")).toBeNull();
      expect(screen.queryByTestId("turn-status-diffstat")).toBeNull();
    });
  });

  it("refreshes diffstat on HEAD change", async () => {
    renderRails();
    await waitFor(() => expect(loadGitStatus).toHaveBeenCalledTimes(1));
    act(() => {
      emitGitHeadChanged();
    });
    await waitFor(() => expect(loadGitStatus).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("turn-status-diffstat")).toHaveTextContent("12");
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
