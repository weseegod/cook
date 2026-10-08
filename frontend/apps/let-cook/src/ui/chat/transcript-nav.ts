import { rowOffset } from "./transcript-window";

export interface TranscriptNavRow {
  type: string;
  role?: string;
  turnId?: string;
}

/** Anything past the viewport bottom is content below; `slack` only absorbs rounding. */
export function hasContentBelow(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  slack = 2,
): boolean {
  return scrollHeight - scrollTop - clientHeight > slack;
}

/** One scroll-tick signal for follow mode. */
export interface FollowSignal {
  /** The pane wrote this position itself, so the mode stays as it was. */
  programmatic: boolean;
  /** A downward wheel arrived while the scroller already sat at the tail. */
  overscroll: boolean;
  /** Nothing is left below the viewport bottom. */
  atTail: boolean;
}

/**
 * Follow mode after one tick, mirroring the TUI's scrollback (`scrollback/state/nav.rs`): `scroll_up`
 * clears follow outright, and `scroll_down` re-engages it only on an overscroll at the tail
 * (`follow_by_overscroll`). Landing on the bottom by scrolling leaves follow alone, so a fast
 * scroll-down never re-enters follow by accident.
 */
export function resolveFollow(current: boolean, signal: FollowSignal): boolean {
  if (signal.programmatic) return current;
  if (signal.overscroll) return true;
  return signal.atTail ? current : false;
}

/** The last user row whose top has moved above the viewport. */
export function stickyPromptIndex(
  rows: readonly TranscriptNavRow[],
  scrollTop: number,
  heights: readonly number[],
  estimate = 72,
): number | null {
  const offsets = new Array<number>(rows.length + 1).fill(0);
  for (let index = 0; index < rows.length; index += 1) {
    const height = heights[index] !== undefined && heights[index] > 0 && Number.isFinite(heights[index])
      ? heights[index]
      : estimate;
    offsets[index + 1] = offsets[index] + height;
  }
  let result: number | null = null;
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].role === "user" && offsets[index] < scrollTop) result = index;
  }
  return result;
}

/** Find the first non-user row belonging to the prompt's turn. */
export function responseTopIndex(rows: readonly TranscriptNavRow[], promptIndex: number | null): number | null {
  if (promptIndex === null || !rows[promptIndex]) return null;
  const prompt = rows[promptIndex];
  for (let index = promptIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.role === "user") break;
    // Tool/verb-group rows carry their turn id in their nested payload, so the projected row
    // itself may not expose one. The next non-user row is the response partner by construction.
    if (row.turnId === prompt.turnId || !prompt.turnId || row.type !== "message") return index;
  }
  return null;
}

export function hasResponseTopAbove(
  rows: readonly TranscriptNavRow[],
  promptIndex: number | null,
  scrollTop: number,
  heights: readonly number[],
  estimate = 72,
): boolean {
  const responseIndex = responseTopIndex(rows, promptIndex);
  return responseIndex !== null && rowOffset(responseIndex, heights, estimate) < scrollTop;
}
