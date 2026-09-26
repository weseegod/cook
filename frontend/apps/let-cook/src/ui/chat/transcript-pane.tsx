/**
 * The transcript surface: a native scroller with follow mode, height-windowed rows, the sticky
 * prompt, and the two jump buttons (`views/agent.rs` scrollback + `transcript-window.ts`).
 *
 * It is presentational on purpose — it takes blocks and nothing else. The main chat feeds it the
 * session transcript; a subagent's own view feeds it that child's transcript. Everything a session
 * adds around it (turn-status, prompt slot, dialogs) rides in the slots below.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TranscriptBlock } from "../../state/session";
import { TranscriptActionsContext } from "./transcript-context";
import { TranscriptRow } from "./transcript-row";
import { hasContentBelow, hasResponseTopAbove, responseTopIndex, stickyPromptIndex } from "./transcript-nav";
import { isLiveTool, projectTranscript, type DisplayBlock } from "./transcript-projection";
import {
  captureContentAnchor,
  contentAnchorScrollTop,
  estimateRowHeight,
  rowOffset,
  windowRange,
  type ContentAnchor,
} from "./transcript-window";

const WINDOW_ESTIMATE = 72;
const WINDOW_OVERSCAN = 8;
const WINDOW_MIN_COUNT = 64;

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

function rowDomId(id: string): string {
  return `transcript-row-${encodeURIComponent(id)}`;
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
  const contentAnchorRef = useRef<ContentAnchor | null>(null);
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

  const pinToBottom = useCallback((element: HTMLDivElement) => {
    const target = Math.max(0, element.scrollHeight - element.clientHeight);
    if (Math.abs(element.scrollTop - target) < 1) return;
    programmaticScrollRef.current = true;
    element.scrollTop = target;
  }, []);

  const updateScrollState = useCallback((element: HTMLDivElement) => {
    const programmatic = programmaticScrollRef.current;
    programmaticScrollRef.current = false;
    const nextFollow = !hasContentBelow(element.scrollHeight, element.scrollTop, element.clientHeight);
    if (!programmatic && nextFollow !== followRef.current) setFollowMode(nextFollow);
    contentAnchorRef.current = captureContentAnchor(
      projectedRef.current,
      element.scrollTop,
      measureHeights(projectedRef.current, rowHeights.current),
      WINDOW_ESTIMATE,
    );
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
    setFollowMode(true);
    const transcript = transcriptRef.current;
    if (!transcript) return;
    contentAnchorRef.current = null;
    pinToBottom(transcript);
    updateScrollState(transcript);
  }, [pinToBottom, setFollowMode, updateScrollState]);

  const pageScroll = useCallback((direction: "up" | "down") => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const distance = Math.max(1, transcript.clientHeight - 48);
    transcript.scrollTop += direction === "up" ? -distance : distance;
    updateScrollState(transcript);
  }, [updateScrollState]);

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
      programmaticScrollRef.current = true;
      current.scrollTop = mounted?.offsetTop ?? rowOffset(index, heights, WINDOW_ESTIMATE);
      contentAnchorRef.current = captureContentAnchor(
        projectedRef.current,
        current.scrollTop,
        measureHeights(projectedRef.current, rowHeights.current),
        WINDOW_ESTIMATE,
      );
      updateScrollState(current);
    };
    snap();
    scheduleFrame(snap);
  }, [heights, projected, setFollowMode, updateScrollState]);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    if (followRef.current) {
      pinToBottom(transcript);
      return;
    }
    const anchor = contentAnchorRef.current;
    if (!anchor) return;
    const next = contentAnchorScrollTop(projected, anchor, heights, WINDOW_ESTIMATE);
    if (next === null) return;
    if (Math.abs(transcript.scrollTop - next) > 1) {
      programmaticScrollRef.current = true;
      transcript.scrollTop = next;
    }
  }, [follow, heights, measurementVersion, pinToBottom, projected, range.end, range.padBottom, range.padTop, range.start, range.tailStart, streaming]);

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
              onScroll={(event) => updateScrollState(event.currentTarget)}
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
