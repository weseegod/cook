import { useEffect } from "react";
import { create } from "zustand";
import { loadGitStatus, type GitStatusSummary } from "../../acp/workspace";
import { GIT_HEAD_CHANGED_EVENT } from "../../state/artifacts";
import { useSessionStore } from "../../state/session";

/** Idle cadence: nothing writes the working tree between turns, so a slow poll is enough. */
const IDLE_INTERVAL_MS = 4_000;
/** During a turn the tree moves under us, and the header's line changes should follow it. */
const RUNNING_INTERVAL_MS = 1_500;

/** Snapshot used when git cannot answer: a folder outside a repository, or a host with no sidecar. */
const NO_REPOSITORY: GitStatusSummary = {
  isGitRepo: false,
  branch: null,
  changedFiles: 0,
  additions: 0,
  deletions: 0,
  operationInProgress: false,
};

/** A dirty-tree summary together with the folder it describes. */
export interface GitStatusSnapshot {
  cwd: string;
  status: GitStatusSummary;
}

interface GitStatusState {
  /** Latest answer, or null while no workspace is open and the first probe has not answered. */
  snapshot: GitStatusSnapshot | null;
  setSnapshot: (snapshot: GitStatusSnapshot | null) => void;
}

/**
 * The one dirty-tree snapshot behind the header: the git chip names the branch from it and the
 * line-change rail reads its totals, so a header carrying both still runs a single `git status`
 * per probe rather than one per element.
 */
export const useGitStatusStore = create<GitStatusState>((set) => ({
  snapshot: null,
  setSnapshot: (snapshot) => set({ snapshot }),
}));

/**
 * The snapshot for `cwd`, or null when the probe has not answered for that folder yet. Every
 * conversation belongs to a workspace of its own, so a summary probed for another one must never
 * name this one's branch: it is dropped until its own probe lands.
 */
export function gitStatusFor(cwd: string | null): GitStatusSummary | null {
  const { snapshot } = useGitStatusStore.getState();
  return snapshot && snapshot.cwd === cwd ? snapshot.status : null;
}

export function useGitStatus(cwd: string | null): GitStatusSummary | null {
  const snapshot = useGitStatusStore((state) => state.snapshot);
  return snapshot && snapshot.cwd === cwd ? snapshot.status : null;
}

let probing = false;
let refreshQueued = false;

/**
 * Refresh the shared snapshot. One probe in flight: a slow `git status` must not stack up. A call
 * that arrives while one runs — the workspace moved under it — is answered by the running loop
 * instead of being dropped, which is what makes switching conversations update the chip at once.
 */
export async function refreshGitStatus(): Promise<void> {
  if (probing) {
    refreshQueued = true;
    return;
  }
  probing = true;
  try {
    do {
      refreshQueued = false;
      const cwd = useSessionStore.getState().cwd;
      if (!cwd) {
        // No workspace: the previous folder's branch must not outlive it.
        useGitStatusStore.getState().setSnapshot(null);
        continue;
      }
      let status: GitStatusSummary;
      try {
        status = await loadGitStatus();
      } catch {
        // No sidecar to ask (a plain browser) or no git binary: report "no repository" instead of
        // holding a stale snapshot, so callers fall back to the edits they can already see.
        status = NO_REPOSITORY;
      }
      useGitStatusStore.getState().setSnapshot({ cwd, status });
    } while (refreshQueued);
  } finally {
    probing = false;
  }
}

/** True when the open turn has run a tool — the only thing that writes the workspace. */
function turnRanTool(state: ReturnType<typeof useSessionStore.getState>): boolean {
  const turnId = state.transcriptCursor.turnId;
  // Without a turn id there is nothing to attribute blocks to, so assume the tree may have moved.
  if (!turnId) return true;
  return state.blocks.some((block) => block.type === "tool" && block.turnId === turnId);
}

/**
 * Keep the shared snapshot fresh. Mounted once, from the git chip: its cadence follows the turn —
 * faster while the agent is editing, idle otherwise — and a turn that has run no tool cannot have
 * changed the tree, so those ticks spawn no git process at all.
 */
export function useGitStatusPoll(): void {
  const cwd = useSessionStore((state) => state.cwd);
  const turnRunning = useSessionStore((state) => state.turnRunning);

  // A commit moves HEAD, which nothing else in the header reports.
  useEffect(() => {
    if (!cwd) return;
    const onHead = () => void refreshGitStatus();
    window.addEventListener(GIT_HEAD_CHANGED_EVENT, onHead);
    return () => window.removeEventListener(GIT_HEAD_CHANGED_EVENT, onHead);
  }, [cwd]);

  useEffect(() => {
    if (!cwd) {
      // No workspace: the previous folder's branch must not outlive it.
      useGitStatusStore.getState().setSnapshot(null);
      return;
    }
    // Opening a conversation moves the workspace with it, and turn edges bracket the edits; both
    // are why this probe runs right away. Mid-turn the timer below covers the rest.
    const state = useSessionStore.getState();
    if (!state.turnRunning || turnRanTool(state)) void refreshGitStatus();
    const timer = window.setInterval(() => {
      const now = useSessionStore.getState();
      if (now.turnRunning && !turnRanTool(now)) return;
      void refreshGitStatus();
    }, turnRunning ? RUNNING_INTERVAL_MS : IDLE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [cwd, turnRunning]);
}
