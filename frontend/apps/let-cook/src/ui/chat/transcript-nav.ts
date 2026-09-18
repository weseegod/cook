import { rowOffset } from "./transcript-window";

export interface TranscriptNavRow {
  type: string;
  role?: string;
  turnId?: string;
}

export function hasContentBelow(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = 96,
): boolean {
  return scrollHeight - scrollTop - clientHeight > threshold;
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
