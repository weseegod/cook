import { useEffect, useRef, type ReactNode } from "react";
import { useSessionStore } from "../../state/session";
import { COMPOSER_SHOW_TPS_KEY, useBooleanPref } from "../preferences";
import {
  ComposerMetricsHost,
  ComposerTpsRail,
  useComposerMetricsStore,
} from "./composer-rails";
import { formatDuration } from "./format-duration";
import {
  BRAILLE_FRAMES,
  activityParts,
  isSendableWait,
  phaseKey,
  resolveTurnActivity,
  type TurnActivity,
} from "./turn-activity";
import { useSpinFrame } from "./use-spin-frame";

/**
 * When the phase on screen started, keyed by `phaseKey`. The TUI restarts the phase clock on every
 * transition (`views/turn_status.rs`), and a child view runs the same clock on its own activity.
 */
export function usePhaseClock(key: string | null): number | null {
  const phase = useRef<{ key: string | null; startedAt: number }>({ key: null, startedAt: Date.now() });
  useEffect(() => {
    if (key !== phase.current.key) phase.current = { key, startedAt: Date.now() };
  }, [key]);
  return key === null ? null : phase.current.startedAt;
}

/**
 * The status row itself, without the session it came from: the parent chat and a subagent's own
 * view paint the same row for their own activity.
 */
export function TurnStatusRow({
  activity,
  phaseStartedAt,
  tick,
  blocked = false,
  queuedHint = null,
  trailing = null,
}: {
  activity: TurnActivity;
  phaseStartedAt: number | null;
  tick: number;
  blocked?: boolean;
  queuedHint?: string | null;
  /** Right-aligned controls the surface owns — the parent's t/s rail. */
  trailing?: ReactNode;
}) {
  const parts = activityParts(activity);
  // An ask owns the row while its card is open, and its phase timer is hidden.
  const elapsed = phaseStartedAt === null || activity.kind === "ask" ? null : Math.max(0, Date.now() - phaseStartedAt);
  return (
    <div className="turn-status" data-testid="turn-status" role="status" aria-live="polite">
      <span className={`turn-status-spinner${blocked ? " blocked" : ""}`} aria-hidden="true">
        {blocked ? "◆" : BRAILLE_FRAMES[tick % BRAILLE_FRAMES.length]}
      </span>
      <span className="turn-status-label" title={parts.text}>
        {parts.prefix && parts.subject
          ? (
            <>
              <span className="turn-status-prefix">{parts.prefix}</span>
              <span className="turn-status-subject accent">{parts.subject}</span>
            </>
          )
          : parts.text}
      </span>
      {elapsed !== null && <span className="turn-status-phase">{formatDuration(elapsed)}</span>}
      {queuedHint && <span className="turn-status-queued">{queuedHint}</span>}
      <span className="turn-status-spacer" />
      {trailing}
    </div>
  );
}

/**
 * The live activity row between the transcript and the prompt (`views/turn_status.rs`), reading
 * left to right: what the turn is doing and its phase timer, then tokens/sec at the right. Working
 * tree line changes live in the header beside the git chip and context usage in the composer,
 * so neither is repeated here. Hidden while idle unless a frozen t/s reading remains.
 */
export function TurnStatus() {
  const derived = useSessionStore((state) => state.activity);
  const turnRunning = useSessionStore((state) => state.turnRunning);
  const queued = useSessionStore((state) => state.queuedPromptCount);
  const pendingQuestion = useSessionStore((state) => state.pendingQuestion);
  const pendingPermission = useSessionStore((state) => state.pendingPermission);
  const [showTps] = useBooleanPref(COMPOSER_SHOW_TPS_KEY);
  const tps = useComposerMetricsStore((state) => state.tps);
  const tick = useSpinFrame(turnRunning);

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

  const phaseStartedAt = usePhaseClock(phaseKey(resolved));
  const hasTps = showTps && tps != null && tps > 0;
  const blocked = Boolean(pendingPermission || pendingQuestion);
  const queuedHint = !resolved || queued === 0 || blocked
    ? null
    : turnRunning || isSendableWait(resolved) ? ` · ${queued} queued, Enter to send now` : ` · ${queued} queued`;

  if (!resolved && !hasTps) {
    return <ComposerMetricsHost />;
  }

  return (
    <>
      <ComposerMetricsHost />
      {resolved ? (
        <TurnStatusRow
          activity={resolved}
          phaseStartedAt={phaseStartedAt}
          tick={tick}
          blocked={blocked}
          queuedHint={queuedHint}
          trailing={<ComposerTpsRail />}
        />
      ) : (
        <div className="turn-status idle-metrics" data-testid="turn-status" role="status" aria-live="off">
          <span className="turn-status-spacer" />
          <ComposerTpsRail />
        </div>
      )}
    </>
  );
}
