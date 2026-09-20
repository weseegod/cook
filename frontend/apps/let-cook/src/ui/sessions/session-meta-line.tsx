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
 * window has open, since `workingSessions` tracks turns per session.
 */
export function SessionMetaLine(
  { sessionId, active, children }: { sessionId: string; active: boolean; children: ReactNode },
) {
  const turn = useSessionStore((state) => state.workingSessions[sessionId]);
  if (!turn) return <>{children}</>;
  return <TurnStatusLine turn={turn} active={active} />;
}

function TurnStatusLine({ turn, active }: { turn: SessionTurn; active: boolean }) {
  const turnRunning = useSessionStore((state) => state.turnRunning);
  const derived = useSessionStore((state) => state.activity);
  const turnStartedAt = useSessionStore((state) => state.turnStartedAt);
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
  // The open conversation times its turn on the shared clock, pauses included, exactly like the
  // chat's own status row; a conversation in the background counts from when its prompt went out.
  const elapsed = live && turnStartedAt !== null
    ? turnElapsedMs({ turnStartedAt, turnPausedMs, questionOpenedAt })
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
