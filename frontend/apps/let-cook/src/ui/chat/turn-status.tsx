import { useEffect, useRef } from "react";
import { acpClient } from "../../acp/client";
import { turnElapsedMs, useSessionStore } from "../../state/session";
import {
  COMPOSER_SHOW_DIFFSTAT_KEY,
  COMPOSER_SHOW_TPS_KEY,
  useBooleanPref,
} from "../preferences";
import {
  ComposerDiffstatRail,
  ComposerMetricsHost,
  ComposerTpsRail,
  useComposerMetricsStore,
} from "./composer-rails";
import { formatDuration, formatTokensShort } from "./format-duration";
import {
  BRAILLE_FRAMES,
  activityParts,
  isSendableWait,
  phaseKey,
  resolveTurnActivity,
} from "./turn-activity";
import { useSpinFrame } from "./use-spin-frame";

/**
 * The live activity row between the transcript and the prompt (`views/turn_status.rs`).
 * Hidden while idle unless frozen TPS / diffstat metrics remain from the last turn.
 */
export function TurnStatus() {
  const derived = useSessionStore((state) => state.activity);
  const turnRunning = useSessionStore((state) => state.turnRunning);
  const turnStartedAt = useSessionStore((state) => state.turnStartedAt);
  const turnPausedMs = useSessionStore((state) => state.turnPausedMs);
  const questionOpenedAt = useSessionStore((state) => state.questionOpenedAt);
  const usage = useSessionStore((state) => state.usage);
  const queued = useSessionStore((state) => state.queuedPromptCount);
  const pendingQuestion = useSessionStore((state) => state.pendingQuestion);
  const pendingPermission = useSessionStore((state) => state.pendingPermission);
  const [showTps] = useBooleanPref(COMPOSER_SHOW_TPS_KEY);
  const [showDiff] = useBooleanPref(COMPOSER_SHOW_DIFFSTAT_KEY);
  const tps = useComposerMetricsStore((state) => state.tps);
  const hasDiffSnapshot = useComposerMetricsStore((state) => state.hasDiffSnapshot);
  const additions = useComposerMetricsStore((state) => state.additions);
  const deletions = useComposerMetricsStore((state) => state.deletions);
  const tick = useSpinFrame(turnRunning);
  const phase = useRef<{ key: string | null; startedAt: number }>({ key: null, startedAt: Date.now() });

  // Goal verification runs in-turn while the model is idle, so the TUI labels the whole window
  // `Verifying…` ahead of any stale streaming activity (`views/turn_status.rs::compute_activity`).
  const goalVerifying = useSessionStore((state) => state.goal?.verifyingCompletion === true);
  // An ask tool owns the row while its card is open (`AskUserQuestion`), and its phase timer is hidden.
  const resolved = resolveTurnActivity({
    derived,
    turnRunning,
    goalVerifying,
    askDetail: pendingQuestion?.kind === "question" ? pendingQuestion.title ?? "" : null,
  });

  const key = phaseKey(resolved);
  useEffect(() => {
    if (key !== phase.current.key) phase.current = { key, startedAt: Date.now() };
  }, [key]);

  const hasTps = showTps && tps != null && tps > 0;
  const hasDiff = showDiff && hasDiffSnapshot && (additions > 0 || deletions > 0);
  const hasMetrics = hasTps || hasDiff;

  const now = Date.now();
  const parts = resolved ? activityParts(resolved) : null;
  const turnElapsed = turnStartedAt === null ? null : turnElapsedMs({ turnStartedAt, turnPausedMs, questionOpenedAt }, now);
  const phaseElapsed = !resolved || key === null || resolved.kind === "ask" ? null : Math.max(0, now - phase.current.startedAt);
  const blocked = Boolean(pendingPermission || pendingQuestion);
  const queuedHint = !resolved || queued === 0
    ? null
    : isSendableWait(resolved) ? ` · ${queued} queued, Enter to send now` : ` · ${queued} queued`;
  const tokens = tokenCount(usage);

  if (!resolved && !hasMetrics) {
    return <ComposerMetricsHost />;
  }

  return (
    <>
      <ComposerMetricsHost />
      <div
        className={`turn-status${resolved ? "" : " idle-metrics"}`}
        data-testid="turn-status"
        role="status"
        aria-live={resolved ? "polite" : "off"}
      >
        {resolved ? (
          <>
            <span className={`turn-status-spinner${blocked ? " blocked" : ""}`} aria-hidden="true">
              {blocked ? "◆" : BRAILLE_FRAMES[tick % BRAILLE_FRAMES.length]}
            </span>
            <span className="turn-status-label" title={parts!.text}>
              {parts!.prefix && parts!.subject
                ? (
                  <>
                    <span className="turn-status-prefix">{parts!.prefix}</span>
                    <span className="turn-status-subject accent">{parts!.subject}</span>
                  </>
                )
                : parts!.text}
            </span>
            {phaseElapsed !== null && <span className="turn-status-phase">{formatDuration(phaseElapsed)}</span>}
            {queuedHint && <span className="turn-status-queued">{queuedHint}</span>}
          </>
        ) : null}
        <span className="turn-status-spacer" />
        {turnElapsed !== null && resolved && <span className="turn-status-timer">{formatDuration(turnElapsed)}</span>}
        {tokens !== null && resolved && <span className="turn-status-tokens">⇣{formatTokensShort(tokens)}</span>}
        <ComposerTpsRail />
        <ComposerDiffstatRail />
        {turnRunning && (
          <button type="button" className="stop-button turn-status-stop" onClick={() => void acpClient.cancel()}>
            [stop]
          </button>
        )}
      </div>
    </>
  );
}

function tokenCount(usage: Record<string, unknown> | null): number | null {
  const used = Number(usage?.used ?? usage?.totalTokens ?? 0);
  return Number.isFinite(used) && used > 0 ? used : null;
}
