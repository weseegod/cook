import { useEffect, useRef } from "react";
import { Bot, Brain, UserRound } from "lucide-react";
import { useSessionStore, type MessageBlock, type PlanBlock, type ToolBlock } from "../../state/session";
import { Composer } from "./composer";
import { Markdown } from "./markdown";
import { StatusBar } from "./status-bar";
import { ToolCard } from "./tool-card";

export function ChatView() {
  const { blocks, sessionId, turnRunning, planMode } = useSessionStore();
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: turnRunning ? "auto" : "smooth" });
  }, [blocks, turnRunning]);

  return (
    <div className="chat-layout">
      {planMode && <div className="plan-banner"><Brain size={15} /> Plan mode — Thanh will inspect and propose before changing files.</div>}
      <div className="transcript">
        {blocks.length === 0 ? (
          <div className="empty-chat">
            <h2>{sessionId ? "What should we work on?" : "Start a conversation"}</h2>
            <p>Ask about this codebase, request a change, or type <kbd>/</kbd> for commands.</p>
          </div>
        ) : blocks.map((block) => {
          if (block.type === "message") return <Message key={`${block.role}-${block.id}`} block={block} />;
          if (block.type === "tool") return <ToolCard key={block.id} tool={block as ToolBlock} />;
          return <Plan key={block.id} plan={block as PlanBlock} />;
        })}
        {turnRunning && <div className="thinking"><span /><span /><span /></div>}
        <div ref={endRef} />
      </div>
      <StatusBar />
      <Composer />
    </div>
  );
}

function Message({ block }: { block: MessageBlock }) {
  if (block.role === "thought") {
    return <details className="thought-block"><summary><Brain size={14} /> Reasoning</summary><Markdown text={block.text} /></details>;
  }
  return (
    <article className={`message message-${block.role}`}>
      <div className="message-avatar">{block.role === "user" ? <UserRound size={17} /> : <Bot size={17} />}</div>
      <div className="message-body">
        {block.images.map((src) => <img key={src.slice(-32)} src={src} alt="Agent output" />)}
        <Markdown text={block.text} />
      </div>
    </article>
  );
}

function Plan({ plan }: { plan: PlanBlock }) {
  return (
    <section className="plan-card">
      <h3><Brain size={16} /> Plan</h3>
      {plan.entries.length ? <ol>{plan.entries.map((entry, index) => <li key={index}>{renderUnknown(entry)}</li>)}</ol> : <Markdown text={renderUnknown(plan.content)} />}
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
