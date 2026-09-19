import { Gauge } from "lucide-react";
import { memo, useEffect } from "react";
import { create } from "zustand";
import { useSessionStore } from "../../state/session";
import {
  COMPOSER_SHOW_DIFFSTAT_KEY,
  COMPOSER_SHOW_TPS_KEY,
  useBooleanPref,
} from "../preferences";
import {
  computeTps,
  decodeTextForTurn,
  DecodeWindowTracker,
  estimateTokens,
  formatTps,
  resolveMetricsTurnId,
} from "./composer-metrics";
import { editLineCounts } from "./edit-lines";
import { gitStatusFor } from "./git-status";

/** Where the `+N −M` numbers came from; null until the first snapshot lands. */
export type DiffSource = "git" | "edits";

interface ComposerMetricsSnapshot {
  tps: number | null;
  additions: number;
  deletions: number;
  diffSource: DiffSource | null;
  setTps: (tps: number | null) => void;
  setDiff: (additions: number, deletions: number, source: DiffSource) => void;
  clear: () => void;
}

/**
 * Turn metrics read by the header's line-change rail and the status row's tokens/sec: the live rate
 * plus, where git cannot describe the workspace, the `+N −M` of the agent's own edits.
 */
export const useComposerMetricsStore = create<ComposerMetricsSnapshot>((set) => ({
  tps: null,
  additions: 0,
  deletions: 0,
  diffSource: null,
  setTps: (tps) => set({ tps }),
  setDiff: (additions, deletions, diffSource) => set({ additions, deletions, diffSource }),
  clear: () => set({ tps: null, additions: 0, deletions: 0, diffSource: null }),
}));

/** How often a running turn re-measures tokens/sec and the agent's own edits. */
export const SAMPLE_INTERVAL_MS = 1_500;

const decodeTracker = new DecodeWindowTracker();

/**
 * Rolling tokens/sec: each sample reports what the model decoded since the previous sample, so the
 * rail tracks the speed of the phase in flight instead of a whole-turn average. A sample taken while
 * the model is busy with tools measures no decode time and returns null, which holds the last
 * reading rather than blanking the rail mid-turn.
 */
const tpsSampler = {
  previous: null as { tokens: number; decodeMs: number } | null,
  reset(): void {
    this.previous = null;
  },
  sample(
    state: ReturnType<typeof useSessionStore.getState>,
    now = Date.now(),
  ): number | null {
    const tokens = estimateTokens(decodeTextForTurn(state.blocks, state.transcriptCursor.turnId));
    const decodeMs = decodeTracker.liveMs(now);
    const base = this.previous ?? { tokens: 0, decodeMs: 0 };
    this.previous = { tokens, decodeMs };
    return computeTps(tokens - base.tokens, decodeMs - base.decodeMs);
  },
};

type TrackFlags = { trackTps: boolean; trackDiffstat: boolean };

/** Module-level turn watcher — one subscription for the whole app. */
const watcher = {
  flags: { trackTps: false, trackDiffstat: false } as TrackFlags,
  /** Active ComposerMetricsHost mounts (Strict Mode remounts briefly hit 0). */
  hostCount: 0,
  turnId: null as string | null,
  wasRunning: false,
  unsubTurn: null as (() => void) | null,
  unsubReset: null as (() => void) | null,
};

function ensureWatchers(): void {
  if (!watcher.unsubTurn) {
    watcher.unsubTurn = useSessionStore.subscribe((state, prev) => {
      if (!watcher.flags.trackTps && !watcher.flags.trackDiffstat) return;

      if (state.activity?.kind !== prev.activity?.kind || state.turnRunning !== prev.turnRunning) {
        if (watcher.flags.trackTps) {
          decodeTracker.sync(state.activity?.kind ?? null, state.turnRunning);
        }
      }

      if (state.turnRunning === prev.turnRunning) return;

      if (state.turnRunning && !watcher.wasRunning) {
        beginTurn(state.transcriptCursor.turnId);
        return;
      }

      if (!state.turnRunning && watcher.wasRunning) {
        finishOpenTurn(state);
      }
    });
  }

  if (!watcher.unsubReset) {
    watcher.unsubReset = useSessionStore.subscribe((state, prev) => {
      if (prev.blocks.length > 0 && state.blocks.length === 0 && !state.turnRunning) {
        clearMetricsRuntime();
      }
      if (state.sessionId !== prev.sessionId) {
        clearMetricsRuntime();
      }
    });
  }
}

function beginTurn(turnId: string | null): void {
  watcher.turnId = turnId;
  watcher.wasRunning = true;
  const state = useSessionStore.getState();
  // The previous turn's rate must not linger into this one: the first sample lands 1.5s in.
  useComposerMetricsStore.getState().setTps(null);
  tpsSampler.reset();
  if (watcher.flags.trackTps) {
    decodeTracker.sync(state.activity?.kind ?? null, true);
  }
}

function finishOpenTurn(state: ReturnType<typeof useSessionStore.getState>): void {
  watcher.wasRunning = false;
  const turnId = resolveMetricsTurnId(state.blocks, watcher.turnId);
  watcher.turnId = null;

  if (watcher.flags.trackTps) {
    const decodeMs = decodeTracker.finish();
    const text = decodeTextForTurn(state.blocks, turnId);
    useComposerMetricsStore.getState().setTps(computeTps(estimateTokens(text), decodeMs));
  } else {
    decodeTracker.reset();
  }
  tpsSampler.reset();

  if (watcher.flags.trackDiffstat && gitCannotAnswer()) setEditDiff(state, turnId);
}

function clearMetricsRuntime(): void {
  useComposerMetricsStore.getState().clear();
  decodeTracker.reset();
  tpsSampler.reset();
  watcher.turnId = null;
  watcher.wasRunning = false;
}

/**
 * Attach mid-flight if the host mounts (or remounts) while a turn is already running —
 * otherwise we miss the rising edge and never freeze TPS / diffstat at turn end.
 */
function syncWithLiveTurn(): void {
  const state = useSessionStore.getState();
  if (!state.turnRunning) return;
  if (!watcher.wasRunning) {
    beginTurn(state.transcriptCursor.turnId);
    return;
  }
  if (watcher.flags.trackTps) {
    decodeTracker.sync(state.activity?.kind ?? null, true);
  }
}

function setTrackFlags(flags: TrackFlags): void {
  watcher.flags = flags;
  if (flags.trackTps || flags.trackDiffstat) {
    ensureWatchers();
    syncWithLiveTurn();
  }
}

/** Test helper: drop subscriptions. */
export function resetComposerMetricsRuntime(): void {
  watcher.unsubTurn?.();
  watcher.unsubReset?.();
  watcher.unsubTurn = null;
  watcher.unsubReset = null;
  watcher.hostCount = 0;
  watcher.flags = { trackTps: false, trackDiffstat: false };
  clearMetricsRuntime();
}

/** True when the shared git snapshot says this workspace has no repository to describe. */
function gitCannotAnswer(): boolean {
  const { cwd } = useSessionStore.getState();
  const status = gitStatusFor(cwd);
  return status !== null && !status.isGitRepo;
}

/**
 * One sample of the live rate and — where git cannot describe the workspace — of the agent's own
 * edits; the host runs it every {@link SAMPLE_INTERVAL_MS} while a turn is up. In a repository the
 * header's own probe already publishes the working-tree totals, so no sampling happens here.
 */
function sampleMetrics(): void {
  const state = useSessionStore.getState();
  if (watcher.flags.trackTps) {
    const next = tpsSampler.sample(state);
    if (next !== null) useComposerMetricsStore.getState().setTps(next);
  }
  if (watcher.flags.trackDiffstat && gitCannotAnswer()) setEditDiff(state, null);
}

function setEditDiff(
  state: ReturnType<typeof useSessionStore.getState>,
  turnId: string | null,
): void {
  const { additions, deletions } = editLineCounts(state.blocks, turnId ?? state.transcriptCursor.turnId);
  const store = useComposerMetricsStore.getState();
  // Sampled on a timer: only move the store when the numbers actually moved.
  if (store.diffSource === "edits" && store.additions === additions && store.deletions === deletions) return;
  store.setDiff(additions, deletions, "edits");
}

/**
 * Owns the decode-window accumulator, the 1.5s metric sampler, and the turn-end snapshot of the
 * agent's own edits. Mount once from the turn status row; the rails only read the store.
 */
export function useComposerMetrics(opts: { trackTps: boolean; trackDiffstat: boolean }): void {
  const { trackTps, trackDiffstat } = opts;
  const turnRunning = useSessionStore((state) => state.turnRunning);

  useEffect(() => {
    watcher.hostCount += 1;
    setTrackFlags({ trackTps, trackDiffstat });
    return () => {
      watcher.hostCount = Math.max(0, watcher.hostCount - 1);
      // Strict Mode remounts: keep tracking across the brief hostCount===0 gap so we do not
      // reset the decode window mid-turn. Real unmount (leave chat) still clears via timeout.
      const remaining = watcher.hostCount;
      window.setTimeout(() => {
        if (watcher.hostCount !== remaining) return;
        if (watcher.hostCount === 0) setTrackFlags({ trackTps: false, trackDiffstat: false });
      }, 0);
    };
  }, [trackTps, trackDiffstat]);

  useEffect(() => {
    if (!turnRunning || (!trackTps && !trackDiffstat)) return;
    sampleMetrics();
    const timer = window.setInterval(sampleMetrics, SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [trackTps, trackDiffstat, turnRunning]);
}

export const ComposerTpsRail = memo(function ComposerTpsRail() {
  const [show] = useBooleanPref(COMPOSER_SHOW_TPS_KEY);
  const tps = useComposerMetricsStore((state) => state.tps);
  if (!show || tps == null || tps <= 0) return null;
  const label = formatTps(tps);
  const aria = `${label} tokens per second`;
  return (
    <span
      className="turn-status-metric turn-status-tps"
      data-testid="turn-status-tps"
      aria-label={aria}
      title={aria}
    >
      <Gauge size={13} aria-hidden="true" />
      <span className="turn-status-metric-value">{label} t/s</span>
    </span>
  );
});

/** Mounts the metrics tracker when either display pref is on. */
export function ComposerMetricsHost() {
  const [showTps] = useBooleanPref(COMPOSER_SHOW_TPS_KEY);
  const [showDiff] = useBooleanPref(COMPOSER_SHOW_DIFFSTAT_KEY);
  useComposerMetrics({ trackTps: showTps, trackDiffstat: showDiff });
  return null;
}
