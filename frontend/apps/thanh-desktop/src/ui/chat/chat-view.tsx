import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Bot, Brain, Copy, FileCode2, RefreshCw, X } from "lucide-react";
import { acpClient } from "../../acp/client";
import { useSessionStore, type MessageBlock, type SessionEventBlock } from "../../state/session";
import { copyText } from "./clipboard";
import { Markdown } from "./markdown";
import { PlanDialog } from "./plan-dialog";
import { PromptSlot } from "./prompt-slot";
import { TodoOverlay } from "./todo-overlay";
import { TurnStatus } from "./turn-status";
import { ThinkingRow, ToolRow, VerbGroupRow } from "./tool-card";
import { projectTranscript } from "./transcript-projection";

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
  const stickToBottom = useRef(true);
  const projected = useMemo(() => projectTranscript(blocks), [blocks]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript || !stickToBottom.current) return;
    transcript.scrollTo({ top: transcript.scrollHeight, behavior: turnRunning ? "auto" : "smooth" });
  }, [blocks, turnRunning]);

  return (
    <div className="chat-layout">
      <TodoOverlay />
      <div
        className="transcript"
        ref={transcriptRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
        }}
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
        ) : projected.map((block) => {
          if (block.type === "message") {
            if (block.role === "thought") return <ThinkingRow key={block.id} block={block} />;
            return <Message key={`${block.role}-${block.id}`} block={block} />;
          }
          if (block.type === "verb-group") return <VerbGroupRow key={block.id} tools={block.tools} />;
          if (block.type === "tool") return <ToolRow key={block.id} tool={block.tool} />;
          if (block.type === "session-event") return <SessionEvent key={block.id} block={block} />;
          return null;
        })}
      </div>
      <TurnStatus />
      {error && <ChatError error={error} connection={connection} cwd={cwd} />}
      {notice && <div className="notice-banner" data-testid="notice-banner">{notice}</div>}
      <PromptSlot />
      <PlanDialog />
    </div>
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

function SessionEvent({ block }: { block: SessionEventBlock }) {
  return <div className="session-event" data-testid={`session-event-${block.id}`}>{block.text}</div>;
}

function Message({ block }: { block: MessageBlock }) {
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
}
