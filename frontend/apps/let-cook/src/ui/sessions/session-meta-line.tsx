import type { ReactNode } from "react";
import { turnElapsedMs, useSessionStore, type SessionTurn } from "../../state/session";
import { formatDuration } from "../chat/format-duration";
import {
  BRAILLE_FRAMES,
  activityParts,
  resolveTurnActivity,
  type TurnActivity,
} from "../chat/turn-activity";
import { useSpinFrame } from "../chat/use-spin-frame";

/** A turn whose phase the window cannot see reads as the tracker's plain wait. */
const UNKNOWN_PHASE: TurnActivity = { kind: "waiting", reason: { kind: "model" } };

/**
 * The second line of a conversation row: `children` (workspace and date) normally, or the live turn
 * on the right when a prompt is in flight for that conversation — whether or not it is the one the
 * window has open, since `workingSessions` tracks turns per session. A list `live` flag covers the
 * gap before that map has the turn: the row still shows "Working…" instead of a date.
 */
export function SessionMetaLine(
  { sessionId, active, live = false, children }: {
    sessionId: string;
    active: boolean;
    live?: boolean;
    children: ReactNode;
  },
) {
  const turn = useSessionStore((state) => state.workingSessions[sessionId]);
  if (!turn) {
    if (!live) return <>{children}</>;
    return <LiveWithoutPhase />;
  }
  return <TurnStatusLine turn={turn} active={active} />;
}

function LiveWithoutPhase() {
  const frame = useSpinFrame(true);
  return (
    <span
      className="session-turn"
      data-testid="session-turn-status"
      data-live="false"
      title="Working…"
    >
      <span className="session-turn-spinner" aria-hidden="true">
        {BRAILLE_FRAMES[frame % BRAILLE_FRAMES.length]}
      </span>
      <span className="session-turn-label">Working…</span>
    </span>
  );
}

function TurnStatusLine({ turn, active }: { turn: SessionTurn; active: boolean }) {
  const turnRunning = useSessionStore((state) => state.turnRunning);
  const derived = useSessionStore((state) => state.activity);
  const turnPausedMs = useSessionStore((state) => state.turnPausedMs);
  const questionOpenedAt = useSessionStore((state) => state.questionOpenedAt);
  const goalVerifying = useSessionStore((state) => state.goal?.verifyingCompletion === true);
  const pendingQuestion = useSessionStore((state) => state.pendingQuestion);
  const pendingPermission = useSessionStore((state) => state.pendingPermission);
  const frame = useSpinFrame(true);

  // The open conversation resolves its phase from the live stream, pauses included; any other shows
  // the phase that conversation last reported.
  const live = active && turnRunning;
  const activity = (live
    ? resolveTurnActivity({
        derived,
        turnRunning,
        goalVerifying,
        askDetail: pendingQuestion?.kind === "question" ? pendingQuestion.title ?? "" : null,
      })
    : turn.activity) ?? UNKNOWN_PHASE;
  const parts = activityParts(activity);
  const blocked = live && Boolean(pendingPermission || pendingQuestion);
  // Always count from the session's busy start. Send now resets chat `turnStartedAt`, so the open
  // row must not read that field — only subtract open-question pause time when live.
  const elapsed = live
    ? turnElapsedMs({ turnStartedAt: turn.startedAt, turnPausedMs, questionOpenedAt })
    : Date.now() - turn.startedAt;

  return (
    <span
      className="session-turn"
      data-testid="session-turn-status"
      data-live={live ? "true" : "false"}
      title={parts.text}
    >
      <span className={`session-turn-spinner${blocked ? " blocked" : ""}`} aria-hidden="true">
        {blocked ? "◆" : BRAILLE_FRAMES[frame % BRAILLE_FRAMES.length]}
      </span>
      <span className="session-turn-label">{parts.text}</span>
      <span className="session-turn-timer">{formatDuration(elapsed ?? 0)}</span>
    </span>
  );
}
