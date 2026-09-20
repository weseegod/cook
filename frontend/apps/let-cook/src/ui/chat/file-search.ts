/**
 * Fuzzy path ranking and accept-replacement for composer `@` search.
 *
 * Indexing stays on the host; ranking is pure TS so mock Playwright and Tauri share one matcher.
 */

import type { WorkspaceIndexEntry } from "../../acp/workspace";
import {
  type AtContext,
  isDirMode,
  matcherQuery,
  normalizeDisplayPath,
  pathRange,
} from "./at-context";

export const FILE_SEARCH_TOP = 50;
export const FILE_SEARCH_VISIBLE = 8;

export interface FileSearchMatch {
  path: string;
  kind: "file" | "directory";
  score: number;
  /** Character indices in `path` that matched the query (for optional highlight). */
  indices: number[];
}

/** Contract mirrored from TUI `FileSearchReplacement`. */
export interface FileSearchReplacement {
  /** Range to replace — path portion only (excludes `@` / `!`). */
  range: { start: number; end: number };
  text: string;
  cursor: number;
  dismiss: boolean;
  /** When accepting a directory drill, keep whitespace-aware detection anchored. */
  drillPrefix: string | null;
}

export interface AcceptOptions {
  /** Right-arrow drill: directories get the path without a trailing `/` or space. */
  noSpace?: boolean;
}

/** Case-insensitive subsequence score; `null` when the query is not a subsequence of the path. */
export function fuzzyScore(path: string, query: string): { score: number; indices: number[] } | null {
  if (!query) return { score: 0, indices: [] };
  const hay = path.toLowerCase();
  const needle = query.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let hi = 0;
  let prev = -2;
  const slashBonus = 4;
  const runBonus = 6;
  const nameStartBonus = 8;

  const fileStart = path.lastIndexOf("/") + 1;

  for (let ni = 0; ni < needle.length; ni += 1) {
    const ch = needle[ni]!;
    const found = hay.indexOf(ch, hi);
    if (found < 0) return null;
    indices.push(found);
    let add = 1;
    if (found === prev + 1) add += runBonus;
    if (found === 0 || path[found - 1] === "/") add += slashBonus;
    if (found === fileStart) add += nameStartBonus;
    score += add;
    prev = found;
    hi = found + 1;
  }
  // Prefer shorter paths on equal subsequence quality.
  score = score * 1000 - path.length;
  return { score, indices };
}

function depthOne(entries: WorkspaceIndexEntry[]): WorkspaceIndexEntry[] {
  return entries.filter((entry) => !entry.path.includes("/"));
}

function sortBrowse(entries: WorkspaceIndexEntry[]): WorkspaceIndexEntry[] {
  return [...entries].sort((left, right) => {
    const kind = Number(left.kind !== "directory") - Number(right.kind !== "directory");
    if (kind !== 0) return kind;
    return left.path.localeCompare(right.path, undefined, { sensitivity: "base" });
  });
}

/** Rank index entries for the current `@` query. Empty query → depth-1 browse. */
export function rankFileSearch(
  entries: WorkspaceIndexEntry[],
  query: string,
  limit = FILE_SEARCH_TOP,
): FileSearchMatch[] {
  if (!query) {
    return sortBrowse(depthOne(entries))
      .slice(0, limit)
      .map((entry) => ({ path: entry.path, kind: entry.kind, score: 0, indices: [] }));
  }

  const scored: FileSearchMatch[] = [];
  for (const entry of entries) {
    const match = fuzzyScore(entry.path, query);
    if (!match) continue;
    scored.push({
      path: entry.path,
      kind: entry.kind,
      score: match.score,
      indices: match.indices,
    });
  }
  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.path.localeCompare(right.path, undefined, { sensitivity: "base" });
  });
  return scored.slice(0, limit);
}

/**
 * Build the text replacement for accepting a ranked row.
 *
 * - File, or directory outside dir-mode: `@path ` and dismiss.
 * - Directory in dir-mode (Tab/Enter): append `/`, keep open, set drill prefix.
 * - Directory with Right (`noSpace`): path without `/`/space, keep open, set drill prefix.
 */
export function acceptReplacement(
  _text: string,
  ctx: AtContext,
  match: FileSearchMatch,
  options: AcceptOptions = {},
): FileSearchReplacement {
  const range = pathRange(ctx);
  const path = normalizeDisplayPath(match.path);
  const dirMode = isDirMode(ctx);
  const noSpace = Boolean(options.noSpace);

  if (match.kind === "directory" && noSpace) {
    return {
      range,
      text: path,
      cursor: range.start + path.length,
      dismiss: false,
      drillPrefix: path,
    };
  }

  if (match.kind === "directory" && dirMode) {
    // Dir-mode Tab/Enter: append `/` and keep the menu open for children.
    const drilled = `${path}/`;
    return {
      range,
      text: drilled,
      cursor: range.start + drilled.length,
      dismiss: false,
      drillPrefix: path,
    };
  }

  // File, or directory accepted outside dir-mode: insert path + space and close.
  const replacement = `${path} `;
  return {
    range,
    text: replacement,
    cursor: range.start + replacement.length,
    dismiss: true,
    drillPrefix: null,
  };
}

/** Apply a replacement to composer text. */
export function applyReplacement(
  text: string,
  replacement: FileSearchReplacement,
): { text: string; cursor: number } {
  const next =
    text.slice(0, replacement.range.start) + replacement.text + text.slice(replacement.range.end);
  return { text: next, cursor: replacement.cursor };
}

/** Rank using the effective matcher query from an `@` context. */
export function rankForContext(
  entries: WorkspaceIndexEntry[],
  ctx: AtContext,
  limit = FILE_SEARCH_TOP,
): FileSearchMatch[] {
  // Keep a trailing `/` for dir-mode accept behavior, but score without it so `@src/`
  // still matches `src` and `src/main.tsx` (TUI nucleo tolerates this; our subsequence matcher does not).
  const query = matcherQuery(ctx).replace(/\/$/, "");
  return rankFileSearch(entries, query, limit);
}
