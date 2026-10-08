/**
 * The transcript surface: a native scroller with follow mode, height-windowed rows, the sticky
 * prompt, and the two jump buttons (`views/agent.rs` scrollback + `transcript-window.ts`).
 *
 * It is presentational on purpose — it takes blocks and nothing else. The main chat feeds it the
 * session transcript; a subagent's own view feeds it that child's transcript. Everything a session
 * adds around it (turn-status, prompt slot, dialogs) rides in the slots below.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { TranscriptBlock } from "../../state/session";
import { TranscriptActionsContext } from "./transcript-context";
import { TranscriptRow } from "./transcript-row";
import { hasContentBelow, hasResponseTopAbove, resolveFollow, responseTopIndex, stickyPromptIndex } from "./transcript-nav";
import { isLiveTool, projectTranscript, type DisplayBlock } from "./transcript-projection";
import {
  domAnchorScrollTop,
  estimateRowHeight,
  rowOffset,
  windowRange,
} from "./transcript-window";

const WINDOW_ESTIMATE = 72;
const WINDOW_OVERSCAN = 8;
const WINDOW_MIN_COUNT = 64;
/** Programmatic writes pause this long after the last scroll-gesture event, momentum included. */
const SCROLL_GUARD_MS = 200;

interface ScrollMetrics {
  scrollTop: number;
  viewportHeight: number;
  scrollHeight: number;
}

function scheduleFrame(callback: () => void): number {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(callback);
  }
  return window.setTimeout(callback, 0);
}

function cancelFrame(handle: number): void {
  if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(handle);
    return;
  }
  window.clearTimeout(handle);
}

/**
 * True while a scroll gesture is in flight. `pinToBottom`, the anchor restore, and the streaming pin
 * all stand aside for this window: a write over the user's own scroll is what made a live turn's
 * transcript feel like it was fighting the wheel — and the fight is invisible to `scroll` events,
 * because the event then reports the position the pane wrote instead of the one the user asked for.
 * Wheel, touch, and pointer events arm it, and so does every scroll event the pane did not write:
 * a scrollbar drag, a key, and a scroll started outside the pane fire none of the others.
 */
function scrollGestureActive(gestureAt: number): boolean {
  return performance.now() - gestureAt < SCROLL_GUARD_MS;
}

/** How long after the pane's own write a scroll event still counts as the browser answering it. */
const CLAMP_AFTER_WRITE_MS = 32;
/** A trailing clamp lands within this many pixels of the tail the pin asked for. */
const CLAMP_SLACK_PX = 8;

/** Keys the scroller itself handles; any of them means the user is driving the viewport. */
const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

function rowDomId(id: string): string {
  return `transcript-row-${encodeURIComponent(id)}`;
}

/**
 * The row under the viewport top plus the box it had when the pane last read the DOM. Restoring
 * from this keeps a reader's line still: a spacer swap or a measurement that moves the row's
 * `offsetTop` is compensated by exactly that movement, and a row that never moves writes nothing.
 */
interface DomAnchor {
  rowId: string;
  offsetTop: number;
}

/** `.transcript-row` and the scroller share `.transcript-shell` as offsetParent, so this is one box. */
function rowOffsetTop(transcript: HTMLElement, rowId: string): number | null {
  for (const row of transcript.querySelectorAll<HTMLElement>("[data-transcript-row]")) {
    if (row.getAttribute("data-transcript-row") === rowId) return row.offsetTop;
  }
  return null;
}

/** The mounted row whose bottom passes the viewport top, i.e. the first one on screen. */
function captureDomAnchor(transcript: HTMLElement): DomAnchor | null {
  const top = transcript.getBoundingClientRect().top;
  for (const row of transcript.querySelectorAll<HTMLElement>("[data-transcript-row]")) {
    if (row.getBoundingClientRect().bottom > top + 1) {
      const rowId = row.getAttribute("data-transcript-row");
      if (!rowId) continue;
      return { rowId, offsetTop: row.offsetTop };
    }
  }
  return null;
}

function isLiveDisplayBlock(block: DisplayBlock): boolean {
  if (block.type === "message") return block.streaming;
  if (block.type === "tool") return isLiveTool(block.tool);
  if (block.type === "verb-group") return block.tools.some(isLiveTool);
  return false;
}

function stickyText(block: { text: string }): string {
  const text = block.text.replace(/\s+/g, " ").trim();
  return text.length > 260 ? `${text.slice(0, 257).trimEnd()}…` : text;
}

/** Measured height when ResizeObserver has seen the row; per-kind estimate otherwise. */
function measureHeights(
  projected: readonly DisplayBlock[],
  measured: Map<string, number>,
): number[] {
  return projected.map((block) => {
    const height = measured.get(block.id);
    return height !== undefined && height > 0 ? height : estimateRowHeight(block);
  });
}

export function TranscriptPane({
  blocks,
  live = false,
  empty,
  mainSlot,
  children,
}: {
  blocks: readonly TranscriptBlock[];
  /** A turn is in flight for this transcript: keeps the live tail mounted while the user reads back. */
  live?: boolean;
  /** Painted in place of the rows while the transcript holds nothing. */
  empty: ReactNode;
  /** Sits beside the scroller inside `.chat-main` — the parent's plan dialog. */
  mainSlot?: ReactNode;
  /** Everything below the chat column: turn-status, the prompt slot, dialogs. */
  children?: ReactNode;
}) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  /** True for one scroll event after a pin / anchor restore, so follow does not drop on our write. */
  const programmaticScrollRef = useRef(false);
  /** When the pane last changed `scrollTop` itself; a clamp event trails our write closely. */
  const wroteAtRef = useRef(Number.NEGATIVE_INFINITY);
  /** When the user last drove the scroller: wheel, touch, pointer, key, or an unwritten scroll. */
  const gestureAtRef = useRef(Number.NEGATIVE_INFINITY);
  /** When wheel / touch / pointer / key last showed the user's own intent. */
  const userIntentAtRef = useRef(Number.NEGATIVE_INFINITY);
  /** Tail state as of the last scroll event. The pane starts pinned to the tail. */
  const atTailRef = useRef(true);
  /** The row under the viewport top and the offsets it had when the last pass read the DOM. */
  const domAnchorRef = useRef<DomAnchor | null>(null);
  const scrollMetricsFrame = useRef<number | null>(null);
  const pendingScrollMetrics = useRef<ScrollMetrics | null>(null);
  const rowHeights = useRef(new Map<string, number>());
  const rowObserver = useRef<ResizeObserver | null>(null);
  const liveIdsRef = useRef<ReadonlySet<string>>(new Set());
  const projectedRef = useRef<readonly DisplayBlock[]>([]);
  const [follow, setFollow] = useState(true);
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const [scrollMetrics, setScrollMetrics] = useState<ScrollMetrics>({
    scrollTop: 0,
    viewportHeight: 0,
    scrollHeight: 0,
  });
  const projected = useMemo(() => projectTranscript(blocks), [blocks]);
  projectedRef.current = projected;
  const streaming = live || projected.some(isLiveDisplayBlock);
  const liveIds = useMemo(() => {
    const ids = new Set<string>();
    for (const block of projected) {
      if (isLiveDisplayBlock(block)) ids.add(block.id);
    }
    return ids;
  }, [projected]);
  liveIdsRef.current = liveIds;
  const heights = useMemo(
    // `follow` is a dep so leaving follow picks up tail sizes that were skipped while pinning.
    () => measureHeights(projected, rowHeights.current),
    [projected, measurementVersion, follow],
  );

  const setFollowMode = useCallback((enabled: boolean) => {
    followRef.current = enabled;
    setFollow(enabled);
  }, []);

  /** Write `scrollTop` and mark it the pane's own, so the event it fires is not read as a move. */
  const writeScrollTop = useCallback((element: HTMLDivElement, value: number) => {
    if (element.scrollTop === value) return;
    programmaticScrollRef.current = true;
    wroteAtRef.current = performance.now();
    element.scrollTop = value;
  }, []);

  /** `force` is for the deliberate paths (the jump button): a live gesture never blocks those. */
  const pinToBottom = useCallback((element: HTMLDivElement, force = false) => {
    if (!force && scrollGestureActive(gestureAtRef.current)) return;
    const target = Math.max(0, element.scrollHeight - element.clientHeight);
    if (Math.abs(element.scrollTop - target) < 1) return;
    writeScrollTop(element, target);
  }, [writeScrollTop]);

  /**
   * One scroll tick. `writtenByPane` marks a call that follows the pane's own write within the same
   * task, so it cannot be confused with the user leaving the tail.
   */
  const updateScrollState = useCallback((element: HTMLDivElement, writtenByPane = false) => {
    const programmatic = programmaticScrollRef.current;
    programmaticScrollRef.current = false;
    const tailGap = element.scrollHeight - element.scrollTop - element.clientHeight;
    const atTail = !hasContentBelow(element.scrollHeight, element.scrollTop, element.clientHeight);
    atTailRef.current = atTail;
    // The browser answers a pin with a clamped event a few pixels off the tail (WebKit reports less
    // than `scrollHeight - clientHeight`, then nudges). While follow is on, the event trails our
    // write, sits within a few pixels of the tail, and no wheel, touch, pointer, or key arrived
    // after that write, it is the tail moving under the pin rather than the user leaving it; the
    // next pin frame closes the gap. A real gesture is newer than the write, and a real scroll
    // leaves the last screen, so both still drop follow.
    const trailingClamp =
      !programmatic &&
      !writtenByPane &&
      followRef.current &&
      !atTail &&
      tailGap <= CLAMP_SLACK_PX &&
      !scrollGestureActive(userIntentAtRef.current) &&
      userIntentAtRef.current < wroteAtRef.current &&
      performance.now() - wroteAtRef.current <= CLAMP_AFTER_WRITE_MS;
    // A scroll the pane did not write is the user's own, whatever drove it: a scrollbar drag, a
    // key, or a scroll started outside the pane fires no wheel or pointer event on this element,
    // and writing over that position is what sent the transcript back up under the user's hand.
    if (!programmatic && !writtenByPane && !followRef.current) gestureAtRef.current = performance.now();
    if (trailingClamp) {
      setFollowMode(true);
    } else {
      setFollowMode(resolveFollow(followRef.current, { programmatic, overscroll: false, atTail }));
    }
    // Reading every row's box is a layout cost, and the anchor is only consulted with follow off.
    if (!followRef.current) domAnchorRef.current = captureDomAnchor(element);
    pendingScrollMetrics.current = {
      scrollTop: element.scrollTop,
      viewportHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    };
    if (scrollMetricsFrame.current !== null) return;
    scrollMetricsFrame.current = scheduleFrame(() => {
      scrollMetricsFrame.current = null;
      const metrics = pendingScrollMetrics.current;
      if (metrics) setScrollMetrics(metrics);
    });
  }, [setFollowMode]);

  const enableFollow = useCallback(() => {
    // The click that lands right after a drag is still inside the guard window. Treating it as the
    // gesture's continuation would make the layout pass skip the pin, and the window swap to the
    // tail slice would leave the tail off screen with no later pass to bring it back. The pane owns
    // the position from here, so a clamp that trails the pin reads as ours, not as that drag.
    gestureAtRef.current = Number.NEGATIVE_INFINITY;
    userIntentAtRef.current = Number.NEGATIVE_INFINITY;
    setFollowMode(true);
    const transcript = transcriptRef.current;
    if (!transcript) return;
    domAnchorRef.current = null;
    pinToBottom(transcript, true);
    updateScrollState(transcript, true);
  }, [pinToBottom, setFollowMode, updateScrollState]);

  const markScrollGesture = useCallback(() => {
    const now = performance.now();
    gestureAtRef.current = now;
    userIntentAtRef.current = now;
  }, []);

  // `scrollend` lands when momentum stops, so the guard is not cut short mid-gesture the way a
  // fixed timeout is: an anchor restore that fired then would yank the viewport back under the
  // user's finger. The timer above still covers engines without `scrollend`.
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const onScrollEnd = (event: Event) => {
      if (event.target !== transcript) return;
      gestureAtRef.current = Number.NEGATIVE_INFINITY;
    };
    transcript.addEventListener("scrollend", onScrollEnd);
    return () => transcript.removeEventListener("scrollend", onScrollEnd);
  }, []);

  const onTranscriptKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (SCROLL_KEYS.has(event.key)) markScrollGesture();
  }, [markScrollGesture]);

  const onTranscriptWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    markScrollGesture();
    // A downward wheel that found the scroller already at the tail is the native form of the TUI's
    // overscroll (`follow_by_overscroll`), and the one gesture that resumes follow by itself.
    // The browser has already applied this wheel's scroll by the time the event reaches us, so the
    // test is the tail state from before it: a wheel that itself landed on the tail stays manual.
    if (event.deltaY <= 0 || !atTailRef.current) return;
    setFollowMode(true);
  }, [markScrollGesture, setFollowMode]);

  const pageScroll = useCallback((direction: "up" | "down") => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const distance = Math.max(1, transcript.clientHeight - 48);
    writeScrollTop(transcript, transcript.scrollTop + (direction === "up" ? -distance : distance));
    updateScrollState(transcript, true);
  }, [updateScrollState, writeScrollTop]);

  const observeRow = useCallback((node: HTMLDivElement | null) => {
    if (!node || typeof ResizeObserver === "undefined") return;
    if (!rowObserver.current) {
      rowObserver.current = new ResizeObserver((entries) => {
        const changedIds: string[] = [];
        for (const entry of entries) {
          const id = entry.target.getAttribute("data-transcript-row");
          if (!id) continue;
          const height = Math.ceil(entry.contentRect.height);
          if (height > 0 && rowHeights.current.get(id) !== height) {
            rowHeights.current.set(id, height);
            changedIds.push(id);
          }
        }
        if (changedIds.length === 0) return;
        // Live-tail growth while following does not move the viewport; the pin already tracks scrollHeight.
        const tailOnly = followRef.current && changedIds.every((id) => liveIdsRef.current.has(id));
        if (!tailOnly) setMeasurementVersion((version) => version + 1);
      });
    }
    rowObserver.current.observe(node);
    return () => rowObserver.current?.unobserve(node);
  }, []);

  useEffect(() => () => {
    rowObserver.current?.disconnect();
    if (scrollMetricsFrame.current !== null) cancelFrame(scrollMetricsFrame.current);
  }, []);

  // One pin per animation frame while the turn streams: covers async height (shiki, images) without
  // coupling the snap to every measurement tick.
  useEffect(() => {
    if (!follow || !streaming) return;
    let handle = scheduleFrame(function pin() {
      const element = transcriptRef.current;
      if (element && followRef.current) pinToBottom(element);
      handle = scheduleFrame(pin);
    });
    return () => cancelFrame(handle);
  }, [follow, streaming, pinToBottom]);

  const range = useMemo(() => windowRange(projected.length, {
    follow,
    scrollTop: scrollMetrics.scrollTop,
    viewportHeight: scrollMetrics.viewportHeight || 600,
    heights,
    estimate: WINDOW_ESTIMATE,
    overscan: WINDOW_OVERSCAN,
    minCount: WINDOW_MIN_COUNT,
    turnRunning: streaming,
  }), [follow, heights, measurementVersion, projected, scrollMetrics.scrollTop, scrollMetrics.viewportHeight, streaming]);

  const stickyIndex = useMemo(
    () => follow ? null : stickyPromptIndex(projected, scrollMetrics.scrollTop, heights, WINDOW_ESTIMATE),
    [follow, heights, projected, scrollMetrics.scrollTop],
  );
  const responseIndex = useMemo(
    () => responseTopIndex(projected, stickyIndex),
    [projected, stickyIndex],
  );
  const responseTopAbove = !follow && hasResponseTopAbove(
    projected,
    stickyIndex,
    scrollMetrics.scrollTop,
    heights,
    WINDOW_ESTIMATE,
  );

  const scrollToRow = useCallback((index: number) => {
    const transcript = transcriptRef.current;
    const row = projected[index];
    if (!transcript || !row) return;
    setFollowMode(false);
    const snap = () => {
      const current = transcriptRef.current;
      if (!current) return;
      const mounted = document.getElementById(rowDomId(row.id));
      writeScrollTop(current, mounted?.offsetTop ?? rowOffset(index, heights, WINDOW_ESTIMATE));
      domAnchorRef.current = captureDomAnchor(current);
      updateScrollState(current, true);
    };
    snap();
    scheduleFrame(snap);
  }, [heights, projected, setFollowMode, updateScrollState, writeScrollTop]);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    // Mid-gesture the user's position is the truth. The anchor is re-read from it so the first
    // restore after the gesture continues from where they left the transcript, not from where the
    // pane last pinned it.
    if (scrollGestureActive(gestureAtRef.current)) {
      domAnchorRef.current = captureDomAnchor(transcript);
      return;
    }
    if (followRef.current) {
      // This pin is not a second writer fighting the rAF one: the pass that mounts or drops rows
      // changes the scroll extent, and the browser answers with a scroll event that reads as the
      // user leaving the tail, which drops follow before the next frame. Writing the bottom in the
      // same pass keeps that event at the tail. `pinToBottom` stands aside mid-gesture, and it is a
      // no-op once the rAF pin has already reached the bottom.
      pinToBottom(transcript);
      return;
    }
    // Restore from the row's own box, not from an estimate. The line the user is reading keeps its
    // place: a spacer swap or a measurement that moved the row's `offsetTop` is compensated by
    // exactly that movement, and a row that never moved leaves `scrollTop` alone.
    const anchor = domAnchorRef.current ?? captureDomAnchor(transcript);
    if (!anchor) return;
    const next = domAnchorScrollTop(
      transcript.scrollTop,
      anchor.offsetTop,
      rowOffsetTop(transcript, anchor.rowId),
    );
    if (next !== null && Math.abs(next - transcript.scrollTop) > 1) {
      writeScrollTop(transcript, next);
    }
    domAnchorRef.current = captureDomAnchor(transcript);
  }, [follow, heights, measurementVersion, pinToBottom, projected, range.end, range.padBottom, range.padTop, range.start, range.tailStart, streaming, writeScrollTop]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript || followRef.current) return;
    setScrollMetrics((current) => ({
      ...current,
      scrollHeight: transcript.scrollHeight,
      viewportHeight: transcript.clientHeight,
    }));
  }, [projected, range.end, range.padBottom, range.padTop, range.start, range.tailStart]);

  const actions = useMemo(() => ({ enableFollow, pageScroll }), [enableFollow, pageScroll]);
  const contentBelow = hasContentBelow(
    scrollMetrics.scrollHeight,
    scrollMetrics.scrollTop,
    scrollMetrics.viewportHeight,
  );
  const stickyBlock = stickyIndex === null ? null : projected[stickyIndex];

  function renderRow(block: DisplayBlock) {
    return (
      <div
        key={block.id}
        id={rowDomId(block.id)}
        className="transcript-row"
        data-transcript-row={block.id}
        ref={observeRow}
      >
        <TranscriptRow block={block} />
      </div>
    );
  }

  return (
    <TranscriptActionsContext.Provider value={actions}>
      <div className="chat-layout">
        <div className="chat-main">
          <div className="transcript-shell">
            <div
              className="transcript"
              ref={transcriptRef}
              tabIndex={0}
              onScroll={(event) => updateScrollState(event.currentTarget)}
              onWheel={onTranscriptWheel}
              onKeyDown={onTranscriptKeyDown}
              onTouchStart={markScrollGesture}
              onTouchMove={markScrollGesture}
              onPointerDown={markScrollGesture}
            >
              {blocks.length === 0 ? (
                empty
              ) : (
                <>
                  {range.padTop > 0 && <div className="transcript-spacer" style={{ height: range.padTop }} aria-hidden="true" />}
                  {projected.slice(range.start, range.end).map(renderRow)}
                  {range.padBottom > 0 && <div className="transcript-spacer" style={{ height: range.padBottom }} aria-hidden="true" />}
                  {range.tailStart !== null && renderRow(projected[range.tailStart])}
                </>
              )}
            </div>
            {stickyBlock?.type === "message" && stickyBlock.role === "user" && (
              <div className="sticky-prompt" data-testid="sticky-prompt">
                <div className="sticky-prompt-text">{stickyText(stickyBlock)}</div>
                {responseTopAbove && responseIndex !== null && (
                  <button
                    type="button"
                    className="transcript-nav-button response-top"
                    aria-label="Jump to start of response"
                    title="Jump to start of response"
                    onClick={() => scrollToRow(responseIndex)}
                  >
                    ▲
                  </button>
                )}
              </div>
            )}
            {projected.length > 0 && !follow && contentBelow && (
              <button
                type="button"
                className="transcript-nav-button jump-latest"
                aria-label="Jump to latest"
                title="Jump to latest"
                onClick={enableFollow}
              >
                ▼
              </button>
            )}
          </div>
          {mainSlot}
        </div>
        {children}
      </div>
    </TranscriptActionsContext.Provider>
  );
}
