import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Bot, Brain, Copy, FileCode2, RefreshCw, X } from "lucide-react";
import { acpClient } from "../../acp/client";
import { useSessionStore, type MessageBlock, type SessionEventBlock } from "../../state/session";
import { copyText } from "./clipboard";
import { Markdown } from "./markdown";
import { PlanDialog } from "./plan-dialog";
import { PlanFileDialog } from "./plan-file-dialog";
import { PromptSlot } from "./prompt-slot";
import { RecapDialog } from "./recap-dialog";
import { RewindDialog } from "./rewind-dialog";
import { TodoOverlay } from "./todo-overlay";
import { TurnStatus } from "./turn-status";
import { ThinkingRow, ToolRow, VerbGroupRow } from "./tool-card";
import { isLiveTool, projectTranscript, type DisplayBlock } from "./transcript-projection";
import { TranscriptActionsContext } from "./transcript-context";
import { hasContentBelow, hasResponseTopAbove, responseTopIndex, stickyPromptIndex } from "./transcript-nav";
import { rowOffset, windowRange } from "./transcript-window";

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

function rowDomId(id: string): string {
  return `transcript-row-${encodeURIComponent(id)}`;
}

function isLiveDisplayBlock(block: DisplayBlock): boolean {
  if (block.type === "message") return block.streaming;
  if (block.type === "tool") return isLiveTool(block.tool);
  if (block.type === "verb-group") return block.tools.some(isLiveTool);
  return false;
}

function stickyText(block: MessageBlock): string {
  const text = block.text.replace(/\s+/g, " ").trim();
  return text.length > 260 ? `${text.slice(0, 257).trimEnd()}…` : text;
}

export function ChatView() {
  const blocks = useSessionStore((state) => state.blocks);
  const sessionId = useSessionStore((state) => state.sessionId);
  const turnRunning = useSessionStore((state) => state.turnRunning);
  const connection = useSessionStore((state) => state.connection);
  const cwd = useSessionStore((state) => state.cwd);
  const error = useSessionStore((state) => state.error);
  const notice = useSessionStore((state) => state.notice);
  const setComposerDraft = useSessionStore((state) => state.setComposerDraft);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const scrollFrame = useRef<number | null>(null);
  const rowHeights = useRef(new Map<string, number>());
  const rowObserver = useRef<ResizeObserver | null>(null);
  const [follow, setFollow] = useState(true);
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const [scrollMetrics, setScrollMetrics] = useState<ScrollMetrics>({
    scrollTop: 0,
    viewportHeight: 0,
    scrollHeight: 0,
  });
  const projected = useMemo(() => projectTranscript(blocks), [blocks]);
  const heights = useMemo(
    () => projected.map((block) => rowHeights.current.get(block.id) ?? 0),
    [projected, measurementVersion],
  );

  const setFollowMode = useCallback((enabled: boolean) => {
    followRef.current = enabled;
    setFollow(enabled);
  }, []);

  const updateScrollState = useCallback((element: HTMLDivElement) => {
    const nextFollow = !hasContentBelow(element.scrollHeight, element.scrollTop, element.clientHeight);
    setFollowMode(nextFollow);
    setScrollMetrics({
      scrollTop: element.scrollTop,
      viewportHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    });
  }, [setFollowMode]);

  const enableFollow = useCallback(() => {
    setFollowMode(true);
    const transcript = transcriptRef.current;
    if (!transcript) return;
    transcript.scrollTop = transcript.scrollHeight;
    updateScrollState(transcript);
  }, [setFollowMode, updateScrollState]);

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
        let changed = false;
        for (const entry of entries) {
          const id = entry.target.getAttribute("data-transcript-row");
          if (!id) continue;
          const height = Math.ceil(entry.contentRect.height);
          if (height > 0 && rowHeights.current.get(id) !== height) {
            rowHeights.current.set(id, height);
            changed = true;
          }
        }
        if (changed) setMeasurementVersion((version) => version + 1);
      });
    }
    rowObserver.current.observe(node);
  }, []);

  useEffect(() => () => rowObserver.current?.disconnect(), []);

  const range = useMemo(() => windowRange(projected.length, {
    follow,
    scrollTop: scrollMetrics.scrollTop,
    viewportHeight: scrollMetrics.viewportHeight || 600,
    heights,
    estimate: WINDOW_ESTIMATE,
    overscan: WINDOW_OVERSCAN,
    minCount: WINDOW_MIN_COUNT,
    turnRunning: turnRunning || projected.some(isLiveDisplayBlock),
  }), [follow, heights, measurementVersion, projected, scrollMetrics.scrollTop, scrollMetrics.viewportHeight, turnRunning]);

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
      current.scrollTop = mounted?.offsetTop ?? rowOffset(index, heights, WINDOW_ESTIMATE);
      updateScrollState(current);
    };
    snap();
    scheduleFrame(snap);
  }, [heights, projected, setFollowMode, updateScrollState]);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript || !followRef.current) return;
    transcript.scrollTop = transcript.scrollHeight;
    scrollFrame.current = scheduleFrame(() => {
      scrollFrame.current = null;
      const current = transcriptRef.current;
      if (current && followRef.current) {
        current.scrollTop = current.scrollHeight;
        updateScrollState(current);
      }
    });
    return () => {
      if (scrollFrame.current === null) return;
      if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(scrollFrame.current);
      else window.clearTimeout(scrollFrame.current);
      scrollFrame.current = null;
    };
  }, [follow, measurementVersion, projected, range.end, range.padBottom, range.padTop, range.start, turnRunning, updateScrollState]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript || followRef.current) return;
    setScrollMetrics((current) => ({
      ...current,
      scrollHeight: transcript.scrollHeight,
      viewportHeight: transcript.clientHeight,
    }));
  }, [projected, range.end, range.start]);

  const actions = useMemo(() => ({ enableFollow, pageScroll }), [enableFollow, pageScroll]);
  const contentBelow = hasContentBelow(
    scrollMetrics.scrollHeight,
    scrollMetrics.scrollTop,
    scrollMetrics.viewportHeight,
  );
  const stickyBlock = stickyIndex === null ? null : projected[stickyIndex];

  return (
    <TranscriptActionsContext.Provider value={actions}>
      <div className="chat-layout">
        <TodoOverlay />
        <div className="chat-main">
          <div className="transcript-shell">
            <div
              className="transcript"
              ref={transcriptRef}
              onScroll={(event) => updateScrollState(event.currentTarget)}
            >
              {blocks.length === 0 ? (
                <div className="empty-chat">
                  <div className="empty-chat-mark"><Bot size={22} /></div>
                  <h2>{sessionId ? "What should we work on?" : "Start a conversation"}</h2>
                  <p>Ask about this codebase, request a change, or type <kbd>/</kbd> for commands.</p>
                  <div className="empty-chat-actions">
                    <button type="button" onClick={() => setComposerDraft("Review this project and suggest the next step.")}><FileCode2 size={14} /> Review this project</button>
                    <button type="button" onClick={() => setComposerDraft("Explain the architecture of this project.")}><Brain size={14} /> Explain the architecture</button>
                  </div>
                </div>
              ) : (
                <>
                  {range.padTop > 0 && <div className="transcript-spacer" style={{ height: range.padTop }} aria-hidden="true" />}
                  {projected.slice(range.start, range.end).map((block) => (
                    <div
                      key={block.id}
                      id={rowDomId(block.id)}
                      className="transcript-row"
                      data-transcript-row={block.id}
                      ref={observeRow}
                    >
                      {block.type === "message"
                        ? block.role === "thought" ? <ThinkingRow block={block} /> : <Message block={block} />
                        : block.type === "verb-group" ? <VerbGroupRow tools={block.tools} />
                          : block.type === "tool" ? <ToolRow tool={block.tool} />
                            : block.type === "session-event" ? <SessionEvent block={block} />
                              : null}
                    </div>
                  ))}
                  {range.padBottom > 0 && <div className="transcript-spacer" style={{ height: range.padBottom }} aria-hidden="true" />}
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
          <PlanDialog />
        </div>
        <TurnStatus />
        {error && <ChatError error={error} connection={connection} cwd={cwd} />}
        {notice && <div className="notice-banner" data-testid="notice-banner">{notice}</div>}
        <PromptSlot />
        <RewindDialog />
        <RecapDialog />
        <PlanFileDialog />
      </div>
    </TranscriptActionsContext.Provider>
  );
}

function ChatError({ error, connection, cwd }: { error: string; connection: string; cwd: string | null }) {
  return (
    <div className="chat-error" role="alert" data-testid="chat-error">
      <AlertCircle size={15} aria-hidden="true" />
      <div className="error-copy">
        <strong>Something went wrong</strong>
        <span>{error}</span>
      </div>
      <div className="error-actions">
        {connection === "error" && cwd && (
          <button type="button" className="error-retry" onClick={() => void acpClient.connect(cwd).catch(() => undefined)}>
            <RefreshCw size={13} /> Retry
          </button>
        )}
        <button type="button" className="error-dismiss" aria-label="Dismiss error" onClick={() => useSessionStore.getState().set({ error: null })}>
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

export const SessionEvent = memo(function SessionEvent({ block }: { block: SessionEventBlock }) {
  return <div className="session-event" data-testid={`session-event-${block.id}`}>{block.text}</div>;
}, (previous, next) => (
  previous.block.id === next.block.id
  && previous.block.turnId === next.block.turnId
  && previous.block.kind === next.block.kind
  && previous.block.text === next.block.text
));

export function messagePropsEqual(previous: { block: MessageBlock }, next: { block: MessageBlock }): boolean {
  return previous.block.id === next.block.id
    && previous.block.role === next.block.role
    && previous.block.text === next.block.text
    && previous.block.streaming === next.block.streaming
    && previous.block.images.length === next.block.images.length
    && previous.block.images.every((image, index) => image === next.block.images[index]);
}

export const Message = memo(function Message({ block }: { block: MessageBlock }) {
  const [copied, setCopied] = useState(false);
  if (block.role === "thought") return null;
  async function copyMessage() {
    try {
      await copyText(block.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }
  return (
    <article className={`message message-${block.role}`}>
      {block.role === "assistant" && block.text && (
        <div className="message-actions">
          <button type="button" className="text-button" onClick={() => void copyMessage()}>
            <Copy size={12} /> {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
      <div className="message-body">
        {block.images.map((src) => <img key={src.slice(-32)} src={src} alt="Agent output" />)}
        <Markdown text={block.text} streaming={block.streaming} />
      </div>
    </article>
  );
}, messagePropsEqual);
