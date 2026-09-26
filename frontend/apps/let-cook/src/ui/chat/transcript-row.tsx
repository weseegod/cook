/**
 * One projected transcript row, and the message/session-event rows it paints.
 *
 * Both the main chat and a subagent's own view read the same projection
 * (`transcript-projection.ts`), so they must paint it through this one switch: a second copy is
 * how a child view drifts from the parent chat.
 */
import { memo, useLayoutEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import type { MessageBlock, SessionEventBlock } from "../../state/session";
import { copyText } from "./clipboard";
import { Markdown } from "./markdown";
import { ThinkingGroupRow, ThinkingRow, ToolRow, VerbGroupRow } from "./tool-card";
import type { DisplayBlock } from "./transcript-projection";

export function TranscriptRow({ block }: { block: DisplayBlock }) {
  if (block.type === "message") {
    return block.role === "thought" ? <ThinkingRow block={block} /> : <Message block={block} />;
  }
  if (block.type === "verb-group") return <VerbGroupRow tools={block.tools} />;
  if (block.type === "thought-group") return <ThinkingGroupRow id={block.id} thoughts={block.thoughts} />;
  if (block.type === "tool") return <ToolRow tool={block.tool} />;
  if (block.type === "session-event") return <SessionEvent block={block} />;
  return null;
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
          <button type="button" className="chat-action-button" onClick={() => void copyMessage()}>
            <Copy size={12} /> {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
      <div className="message-body">
        {block.images.map((src) => <img key={src.slice(-32)} src={src} alt="Agent output" />)}
        {block.role === "user"
          ? <UserPrompt text={block.text} streaming={block.streaming} />
          : <Markdown text={block.text} streaming={block.streaming} />}
      </div>
    </article>
  );
}, messagePropsEqual);

/**
 * A user prompt, folded when it does not fit three lines (`scrollback/blocks/user.rs`:
 * `COLLAPSED_MAX_LINES`, `default_display_mode`). The clamp is painted, so the row has to measure
 * itself to learn it was cut; the last visible line carries the ellipsis, as it does in the TUI.
 *
 * The same row paints the parent's prompt and a spawned agent's opening brief, so the `/goal`
 * planner's long instructions open folded exactly like a typed one.
 */
function UserPrompt({ text, streaming }: { text: string; streaming: boolean }) {
  const [expanded, setExpanded] = useState(false);
  // Starts folded so the measurement below has a clamped box to read; the prompt is only released
  // if it fits. That happens before paint, so a short one is never painted cut.
  const [clipped, setClipped] = useState(true);
  const clipRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (expanded) return;
    const clip = clipRef.current;
    if (!clip) return;
    // A folded box reports the whole prompt as its scroll height; that overflow is the fold. Watched
    // rather than read once, because the row mounts with the frame it is read in (a subagent's view
    // is built when it opens) and because a narrower window wraps the same prompt onto more lines.
    const measure = () => setClipped(clip.scrollHeight - clip.clientHeight > 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(clip);
    return () => observer.disconnect();
  }, [text, expanded]);
  const folded = clipped && !expanded;
  return (
    <>
      <div className="prompt-clip" ref={clipRef} data-folded={folded ? "true" : "false"}>
        <Markdown text={text} streaming={streaming} />
      </div>
      {clipped && (
        <button
          type="button"
          className="text-button prompt-fold-toggle"
          aria-expanded={expanded}
          data-testid="prompt-fold-toggle"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}
