import { useEffect, useRef } from "react";
import { acpClient } from "../../acp/client";
import { turnElapsedMs, useSessionStore } from "../../state/session";
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
 * Hidden while idle; shows the spinner, the activity label, a per-phase timer on the left and the
 * turn timer, token count and `[stop]` on the right.
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

  if (!resolved) return null;
  const now = Date.now();
  const parts = activityParts(resolved);
  const turnElapsed = turnStartedAt === null ? null : turnElapsedMs({ turnStartedAt, turnPausedMs, questionOpenedAt }, now);
  const phaseElapsed = key === null || resolved.kind === "ask" ? null : Math.max(0, now - phase.current.startedAt);
  const blocked = Boolean(pendingPermission || pendingQuestion);
  const queuedHint = queued === 0
    ? null
    : isSendableWait(resolved) ? ` · ${queued} queued, Enter to send now` : ` · ${queued} queued`;
  const tokens = tokenCount(usage);

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
      {phaseElapsed !== null && <span className="turn-status-phase">{formatDuration(phaseElapsed)}</span>}
      {queuedHint && <span className="turn-status-queued">{queuedHint}</span>}
      <span className="turn-status-spacer" />
      {turnElapsed !== null && <span className="turn-status-timer">{formatDuration(turnElapsed)}</span>}
      {tokens !== null && <span className="turn-status-tokens">⇣{formatTokensShort(tokens)}</span>}
      {turnRunning && (
        <button type="button" className="stop-button turn-status-stop" onClick={() => void acpClient.cancel()}>
          [stop]
        </button>
      )}
    </div>
  );
}

function tokenCount(usage: Record<string, unknown> | null): number | null {
  const used = Number(usage?.used ?? usage?.totalTokens ?? 0);
  return Number.isFinite(used) && used > 0 ? used : null;
}
