import { Gauge, Minus, Plus } from "lucide-react";
import { memo, useEffect } from "react";
import { create } from "zustand";
import { loadGitStatus } from "../../acp/workspace";
import { GIT_HEAD_CHANGED_EVENT } from "../../state/artifacts";
import { useSessionStore } from "../../state/session";
import {
  COMPOSER_SHOW_DIFFSTAT_KEY,
  COMPOSER_SHOW_TPS_KEY,
  useBooleanPref,
} from "../preferences";
import {
  assistantTextForTurn,
  computeTps,
  DecodeWindowTracker,
  estimateTokens,
  formatTps,
  resolveMetricsTurnId,
} from "./composer-metrics";

interface ComposerMetricsSnapshot {
  tps: number | null;
  additions: number;
  deletions: number;
  /** True once we have taken at least one git snapshot this session. */
  hasDiffSnapshot: boolean;
  setTps: (tps: number | null) => void;
  setDiff: (additions: number, deletions: number) => void;
  clear: () => void;
}

export const useComposerMetricsStore = create<ComposerMetricsSnapshot>((set) => ({
  tps: null,
  additions: 0,
  deletions: 0,
  hasDiffSnapshot: false,
  setTps: (tps) => set({ tps }),
  setDiff: (additions, deletions) => set({ additions, deletions, hasDiffSnapshot: true }),
  clear: () => set({ tps: null, additions: 0, deletions: 0, hasDiffSnapshot: false }),
}));

const decodeTracker = new DecodeWindowTracker();

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

function onGitHead(): void {
  if (watcher.flags.trackDiffstat) void snapshotGit();
}

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
    const text = assistantTextForTurn(state.blocks, turnId);
    useComposerMetricsStore.getState().setTps(computeTps(estimateTokens(text), decodeMs));
  } else {
    decodeTracker.reset();
  }

  if (watcher.flags.trackDiffstat) {
    void snapshotGit();
  }
}

function clearMetricsRuntime(): void {
  useComposerMetricsStore.getState().clear();
  decodeTracker.reset();
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
  const wasDiff = watcher.flags.trackDiffstat;
  watcher.flags = flags;
  if (flags.trackTps || flags.trackDiffstat) {
    ensureWatchers();
    syncWithLiveTurn();
  }

  if (flags.trackDiffstat && !wasDiff) {
    window.addEventListener(GIT_HEAD_CHANGED_EVENT, onGitHead);
    void snapshotGit();
  } else if (!flags.trackDiffstat && wasDiff) {
    window.removeEventListener(GIT_HEAD_CHANGED_EVENT, onGitHead);
  }
}

/** Test helper: drop subscriptions and prefs-driven listeners. */
export function resetComposerMetricsRuntime(): void {
  if (watcher.flags.trackDiffstat) {
    window.removeEventListener(GIT_HEAD_CHANGED_EVENT, onGitHead);
  }
  watcher.unsubTurn?.();
  watcher.unsubReset?.();
  watcher.unsubTurn = null;
  watcher.unsubReset = null;
  watcher.hostCount = 0;
  watcher.flags = { trackTps: false, trackDiffstat: false };
  clearMetricsRuntime();
}

async function snapshotGit(): Promise<void> {
  try {
    const status = await loadGitStatus();
    if (!status.isGitRepo) {
      useComposerMetricsStore.getState().setDiff(0, 0);
      return;
    }
    useComposerMetricsStore.getState().setDiff(status.additions, status.deletions);
  } catch {
    // Browser without mock/Tauri: keep the rail hidden (no snapshot).
  }
}

/**
 * Owns the decode-window accumulator and turn-end / HEAD-change snapshots.
 * Mount once from the turn status row. Rails subscribe only to frozen store fields.
 */
export function useComposerMetrics(opts: { trackTps: boolean; trackDiffstat: boolean }): void {
  const { trackTps, trackDiffstat } = opts;

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

export const ComposerDiffstatRail = memo(function ComposerDiffstatRail() {
  const [show] = useBooleanPref(COMPOSER_SHOW_DIFFSTAT_KEY);
  const additions = useComposerMetricsStore((state) => state.additions);
  const deletions = useComposerMetricsStore((state) => state.deletions);
  const hasDiffSnapshot = useComposerMetricsStore((state) => state.hasDiffSnapshot);
  if (!show || !hasDiffSnapshot) return null;
  if (additions === 0 && deletions === 0) return null;
  const aria = `${additions} lines added, ${deletions} lines removed`;
  const title = `+${additions} −${deletions} in the working tree`;
  return (
    <span
      className="turn-status-metric turn-status-diffstat"
      data-testid="turn-status-diffstat"
      aria-label={aria}
      title={title}
    >
      <span className="turn-status-diff-add">
        <Plus size={11} aria-hidden="true" />
        <span className="turn-status-metric-value">{additions}</span>
      </span>
      <span className="turn-status-diff-del">
        <Minus size={11} aria-hidden="true" />
        <span className="turn-status-metric-value">{deletions}</span>
      </span>
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
