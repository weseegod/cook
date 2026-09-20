import { formatDuration } from "../../ui/chat/format-duration";
import type { SessionState, TranscriptCursor, TurnOutcome } from "./types";

/** Turn clock with question-card pauses netted out, in the shared `formatDuration` unit. */
export function turnElapsedMs(
  state: Pick<SessionState, "turnStartedAt" | "turnPausedMs" | "questionOpenedAt">,
  now = Date.now(),
): number | null {
  if (state.turnStartedAt === null) return null;
  const openPause = state.questionOpenedAt === null ? 0 : Math.max(0, now - state.questionOpenedAt);
  return Math.max(0, now - state.turnStartedAt - state.turnPausedMs - openPause);
}

export const emptyCursor = (): TranscriptCursor => ({
  turnId: null,
  assistantId: null,
  thoughtId: null,
  optimisticUserId: null,
});

/** A fresh cursor, for callers outside the store that reduce a transcript of their own. */
export const emptyTranscriptCursor = emptyCursor;

export function turnMarkerText(outcome: TurnOutcome, elapsedMs: number | null): string {
  const duration = elapsedMs === null ? null : formatDuration(elapsedMs);
  if (outcome.kind === "cancelled") {
    const phrase = outcome.phrase ?? "Turn cancelled by user";
    return duration ? `${phrase} in ${duration}.` : `${phrase}.`;
  }
  if (outcome.kind === "failed") {
    const detail = outcome.error?.trim();
    if (duration) return `Turn failed in ${duration}: ${detail ?? "unknown error"}`;
    return `Turn failed: ${detail ?? "unknown error"}`;
  }
  return duration ? `Worked for ${duration}` : "Turn completed.";
}
