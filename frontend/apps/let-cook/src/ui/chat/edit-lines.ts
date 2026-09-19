import type { TranscriptBlock } from "../../state/session";

/**
 * Line changes for a workspace without git.
 *
 * The rail's git path reports the whole working tree, which needs no help. Where git cannot answer —
 * a plain folder, or a machine without the binary — the only change record the renderer already
 * holds is the agent's own edits, which arrive on every write tool call as ACP `diff` content. That
 * source costs nothing to read: no process spawn, no filesystem walk, no file reads. It reports what
 * the agent wrote rather than the state of the tree, so the rail labels the two apart.
 */

/** LCS cells the middle of a hunk may cost before the count degrades to a plain line delta. */
const MAX_LCS_CELLS = 100_000;

/** Lines added and removed by one edit hunk, as a unified diff would report them. */
export function hunkLineCounts(oldText: string, newText: string): { added: number; removed: number } {
  if (oldText === newText) return { added: 0, removed: 0 };
  // An empty side is a new or deleted file: no lines, not one empty line.
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");

  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head += 1;
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }

  const oldMiddle = oldLines.slice(head, oldLines.length - tail);
  const newMiddle = newLines.slice(head, newLines.length - tail);
  if (oldMiddle.length === 0 || newMiddle.length === 0) {
    return { added: newMiddle.length, removed: oldMiddle.length };
  }
  // A hunk pair is usually small enough to diff exactly; a pair too big to walk cheaply is reported
  // as a wholesale replacement rather than stalling the status row's timer.
  if (oldMiddle.length * newMiddle.length > MAX_LCS_CELLS) {
    return { added: newMiddle.length, removed: oldMiddle.length };
  }
  const shared = longestCommonSubsequence(oldMiddle, newMiddle);
  return { added: newMiddle.length - shared, removed: oldMiddle.length - shared };
}

function longestCommonSubsequence(left: readonly string[], right: readonly string[]): number {
  const rows = left.length + 1;
  const columns = right.length + 1;
  let previous = new Array<number>(columns).fill(0);
  let current = new Array<number>(columns).fill(0);
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      current[column] = left[row - 1] === right[column - 1]
        ? previous[column - 1] + 1
        : Math.max(previous[column], current[column - 1]);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return previous[columns - 1];
}

/** What one tool call changed, as `EditToolCallBlock::count_changes` reports it. */
export interface ToolEditStats {
  added: number;
  removed: number;
  /** Hunk count; the collapsed suffix falls back to ` ({n} edits)` from it. */
  hunks: number;
}

const NO_EDITS: ToolEditStats = { added: 0, removed: 0, hunks: 0 };

/**
 * Added, removed, and hunk counts for one tool call's content, for the collapsed
 * `Edit path +N/-M` header (`scrollback/blocks/tool/edit.rs::header_line`).
 */
export function toolLineCounts(content: readonly unknown[]): ToolEditStats {
  let added = 0;
  let removed = 0;
  let hunks = 0;
  for (const record of content) {
    const stats = recordEditStats(record);
    added += stats.added;
    removed += stats.removed;
    hunks += stats.hunks;
  }
  return { added, removed, hunks };
}

/**
 * Added and removed lines the agent's own edits reported for one turn: ACP `diff` content
 * (`oldText`/`newText`, which the shell sends per hunk) plus unified-diff text a tool printed.
 */
export function editLineCounts(
  blocks: readonly TranscriptBlock[],
  turnId: string | null,
): { additions: number; deletions: number } {
  if (!turnId) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const block of blocks) {
    if (block.type !== "tool" || block.turnId !== turnId) continue;
    const stats = toolLineCounts(block.content);
    additions += stats.added;
    deletions += stats.removed;
  }
  return { additions, deletions };
}

function recordEditStats(record: unknown): ToolEditStats {
  if (!record || typeof record !== "object") return NO_EDITS;
  const value = record as Record<string, unknown>;
  const nested = value.content && typeof value.content === "object" ? value.content : value;
  const inner = nested as Record<string, unknown>;
  if (inner.type === "diff" && typeof inner.newText === "string") {
    const { added, removed } = hunkLineCounts(typeof inner.oldText === "string" ? inner.oldText : "", inner.newText);
    return { added, removed, hunks: 1 };
  }
  if (typeof inner.diff === "string") return unifiedDiffStats(inner.diff);
  if (typeof inner.text === "string" && /^[-+@]/m.test(inner.text)) return unifiedDiffStats(inner.text);
  return NO_EDITS;
}

/** Added/removed lines and hunks in unified-diff text, ignoring the `---`/`+++` file headers. */
function unifiedDiffStats(diff: string): ToolEditStats {
  let added = 0;
  let removed = 0;
  let hunks = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("@@")) hunks += 1;
    else if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  // A printed diff without `@@` markers is still one edit.
  return { added, removed, hunks: hunks > 0 || added > 0 || removed > 0 ? Math.max(1, hunks) : 0 };
}
