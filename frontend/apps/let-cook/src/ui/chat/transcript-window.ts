export interface WindowRangeOptions {
  follow: boolean;
  scrollTop: number;
  viewportHeight: number;
  /** Measured or estimated offsetHeight per row. A non-positive value uses `estimate`. */
  heights: readonly number[];
  estimate?: number;
  overscan?: number;
  minCount?: number;
  /** Keep the live tail mounted while a turn is in flight. */
  turnRunning?: boolean;
}

/** A projected row identity, enough to restore a scroll position after a height change. */
export interface RowIdentity {
  id: string;
}

/**
 * Stable pre-measure height for a projected row. Using a flat 72px for every kind made `padTop`
 * jump whenever the window slid over tools or short markers during a live turn.
 */
export function estimateRowHeight(block: { type: string; role?: string }): number {
  if (block.type === "session-event") return 28;
  if (block.type === "message" && block.role === "thought") return 48;
  if (block.type === "tool" || block.type === "verb-group") return 52;
  return 72;
}

/** Viewport-top content pin: which row sits under `scrollTop`, and how far into it. */
export interface ContentAnchor {
  rowId: string;
  /** Pixels from the row's top to the previous `scrollTop` (negative when the row starts above). */
  delta: number;
}

/**
 * Capture the row under `scrollTop` so a later height/pad change can put the same content back
 * under the viewport top (`scrollback/state/mod.rs` `capture_scroll_anchor`).
 */
export function captureContentAnchor(
  rows: readonly RowIdentity[],
  scrollTop: number,
  heights: readonly number[],
  estimate = 72,
): ContentAnchor | null {
  const top = Math.max(0, scrollTop);
  let offset = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const height = rowHeight(heights[index], estimate);
    if (offset + height > top) {
      return { rowId: rows[index].id, delta: top - offset };
    }
    offset += height;
  }
  return null;
}

/** `scrollTop` that puts `anchor.rowId` back under the viewport top, or null if the row is gone. */
export function contentAnchorScrollTop(
  rows: readonly RowIdentity[],
  anchor: ContentAnchor,
  heights: readonly number[],
  estimate = 72,
): number | null {
  let offset = 0;
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].id === anchor.rowId) return offset + anchor.delta;
    offset += rowHeight(heights[index], estimate);
  }
  return null;
}

export interface WindowRange {
  /** Inclusive start, exclusive end. */
  start: number;
  end: number;
  /** Live last row mounted separately when it lies outside the visible window. */
  tailStart: number | null;
  padTop: number;
  padBottom: number;
}

function rowHeight(value: number | undefined, estimate: number): number {
  return value !== undefined && value > 0 && Number.isFinite(value) ? value : estimate;
}

/** Return the estimated/measured top offset of a row. */
export function rowOffset(index: number, heights: readonly number[], estimate = 72): number {
  let offset = 0;
  for (let row = 0; row < Math.max(0, index); row += 1) offset += rowHeight(heights[row], estimate);
  return offset;
}

function cumulativeHeights(count: number, heights: readonly number[], estimate: number): number[] {
  const prefix = new Array<number>(count + 1).fill(0);
  for (let index = 0; index < count; index += 1) {
    prefix[index + 1] = prefix[index] + rowHeight(heights[index], estimate);
  }
  return prefix;
}

function firstRowWithBottomAfter(offset: number, prefix: readonly number[]): number {
  const count = prefix.length - 1;
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (prefix[middle + 1] > offset) high = middle;
    else low = middle + 1;
  }
  return low;
}

function firstRowWithTopAtOrAfter(offset: number, prefix: readonly number[]): number {
  const count = prefix.length - 1;
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (prefix[middle] >= offset) high = middle;
    else low = middle + 1;
  }
  return low;
}

/**
 * Project a transcript onto the native scroller without mounting its whole history.
 * Unknown row heights deliberately remain estimates until ResizeObserver sees the row.
 */
export function windowRange(count: number, options: WindowRangeOptions): WindowRange {
  const safeCount = Math.max(0, Math.floor(count));
  const estimate = Math.max(1, options.estimate ?? 72);
  const overscan = Math.max(0, Math.floor(options.overscan ?? 8));
  const minCount = Math.max(0, Math.floor(options.minCount ?? 64));

  if (safeCount < minCount) return { start: 0, end: safeCount, tailStart: null, padTop: 0, padBottom: 0 };
  const prefix = cumulativeHeights(safeCount, options.heights, estimate);

  let start: number;
  let end: number;
  if (options.follow) {
    end = safeCount;
    start = Math.max(0, safeCount - Math.max(40, overscan * 2));
  } else {
    const scrollTop = Math.max(0, options.scrollTop);
    const viewportBottom = scrollTop + Math.max(1, options.viewportHeight);
    const firstVisible = firstRowWithBottomAfter(scrollTop, prefix);
    const firstAfterViewport = firstRowWithTopAtOrAfter(viewportBottom, prefix);
    start = Math.max(0, firstVisible - overscan);
    end = Math.min(safeCount, Math.max(firstVisible + 1, firstAfterViewport) + overscan);
  }

  if (end < start) end = start;

  const total = prefix[safeCount];
  const padTop = prefix[start];
  // Keep the live last row mounted for its local state and size measurement. A spacer represents
  // the intervening history, so reading back during a long turn still mounts only a small window.
  const tailStart = options.turnRunning && !options.follow && end < safeCount - 1
    ? safeCount - 1
    : null;
  const padBottom = Math.max(0, (tailStart === null ? total : prefix[tailStart]) - prefix[end]);
  return { start, end, tailStart, padTop, padBottom };
}
