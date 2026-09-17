import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Bot, Brain, Copy, FileCode2, RefreshCw, X } from "lucide-react";
import { acpClient } from "../../acp/client";
import { useSessionStore, type MessageBlock, type PlanBlock, type SessionEventBlock } from "../../state/session";
import { PermissionModal } from "../permissions/permission-modal";
import { InteractionModal } from "../permissions/interaction-modal";
import { Composer } from "./composer";
import { copyText } from "./clipboard";
import { Markdown } from "./markdown";
import { TurnStatus } from "./turn-status";
import { ThinkingRow, ToolRow, VerbGroupRow } from "./tool-card";
import { projectTranscript } from "./transcript-projection";

export function ChatView() {
  const blocks = useSessionStore((state) => state.blocks);
  const sessionId = useSessionStore((state) => state.sessionId);
  const turnRunning = useSessionStore((state) => state.turnRunning);
  const planMode = useSessionStore((state) => state.planMode);
  const connection = useSessionStore((state) => state.connection);
  const cwd = useSessionStore((state) => state.cwd);
  const error = useSessionStore((state) => state.error);
  const notice = useSessionStore((state) => state.notice);
  const pendingPermission = useSessionStore((state) => state.pendingPermission);
  const pendingQuestion = useSessionStore((state) => state.pendingQuestion);
  const setComposerDraft = useSessionStore((state) => state.setComposerDraft);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const projected = useMemo(() => projectTranscript(blocks), [blocks]);
  const interactionPending = Boolean(pendingPermission || pendingQuestion);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript || !stickToBottom.current) return;
    transcript.scrollTo({ top: transcript.scrollHeight, behavior: turnRunning ? "auto" : "smooth" });
  }, [blocks, turnRunning]);

  return (
    <div className="chat-layout">
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
          return <Plan key={block.id} plan={block as PlanBlock} />;
        })}
      </div>
      {error && <ChatError error={error} connection={connection} cwd={cwd} />}
      <TurnStatus />
      {planMode && <div className="plan-banner"><Brain size={15} /> Plan mode — Thanh will inspect and propose before changing files.</div>}
      {notice && <div className="notice-banner" data-testid="notice-banner">{notice}</div>}
      {interactionPending && (
        <div className="chat-prompt-dock">
          <PermissionModal />
          <InteractionModal />
        </div>
      )}
      {/* The card replaces the prompt slot visually; the composer stays mounted behind it so a
          half-written draft and its attachments survive the interruption. */}
      <div className={interactionPending ? "prompt-slot stashed" : "prompt-slot"}>
        <Composer />
      </div>
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

function Plan({ plan }: { plan: PlanBlock }) {
  const content = plan.entries.length
    ? plan.entries.map((entry, index) => `${index + 1}. ${renderUnknown(entry)}`).join("\n")
    : renderUnknown(plan.content);
  return (
    <section className="plan-card" data-testid={`plan-${plan.id}`}>
      <header className="plan-card-header"><h3><Brain size={16} /> Plan</h3><button type="button" className="text-button" onClick={() => void copyText(content)}><Copy size={13} /> Copy</button></header>
      {plan.entries.length ? <ol>{plan.entries.map((entry, index) => <li key={index}>{renderUnknown(entry)}</li>)}</ol> : <Markdown text={content} />}
    </section>
  );
}

function renderUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return String(record.content ?? record.title ?? record.description ?? JSON.stringify(value));
  }
  return value == null ? "" : String(value);
}
