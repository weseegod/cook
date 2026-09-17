import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Brain, Copy, FileCode2 } from "lucide-react";
import { acpClient } from "../../acp/client";
import { useSessionStore, type MessageBlock, type PlanBlock } from "../../state/session";
import { PermissionModal } from "../permissions/permission-modal";
import { InteractionModal } from "../permissions/interaction-modal";
import { Composer } from "./composer";
import { copyText } from "./clipboard";
import { Markdown } from "./markdown";
import { StatusBar } from "./status-bar";
import { ActivityGroup, LiveActivityRail } from "./tool-card";
import { projectTranscript } from "./transcript-projection";

export function ChatView() {
  const { blocks, sessionId, turnRunning, turnStartedAt, planMode, notice, pendingPermission, pendingQuestion, setComposerDraft } = useSessionStore();
  const transcriptRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [now, setNow] = useState(Date.now());
  const projected = useMemo(() => projectTranscript(blocks), [blocks]);
  const liveActivities = projected.filter((block): block is Extract<typeof block, { type: "activity" }> => block.type === "activity" && block.status === "running");
  const turnElapsedMs = turnStartedAt === null ? null : Math.max(0, now - turnStartedAt);
  useEffect(() => {
    if (!turnRunning && liveActivities.length === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [turnRunning, liveActivities.length]);
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript || !stickToBottom.current) return;
    transcript.scrollTo({ top: transcript.scrollHeight, behavior: turnRunning ? "auto" : "smooth" });
  }, [blocks, turnRunning]);

  const last = projected.at(-1);
  const hasLiveOutput = last?.type === "activity"
    ? last.status === "running"
    : last?.type === "message" && last.role === "assistant" && last.streaming;

  return (
    <div className="chat-layout">
      {planMode && <div className="plan-banner"><Brain size={15} /> Plan mode — Thanh will inspect and propose before changing files.</div>}
      <LiveActivityRail
        activities={liveActivities}
        turnElapsedMs={turnElapsedMs}
        onCancel={() => void acpClient.cancel()}
      />
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
          if (block.type === "message") return <Message key={`${block.role}-${block.id}`} block={block} />;
          if (block.type === "activity") return <ActivityGroup key={block.id} activity={block} />;
          return <Plan key={block.id} plan={block as PlanBlock} />;
        })}
        {turnRunning && !hasLiveOutput && <div className="turn-activity"><span className="activity-pulse" /> Waiting for response…</div>}
      </div>
      {(pendingPermission || pendingQuestion) && (
        <div className="chat-prompt-dock">
          <PermissionModal />
          <InteractionModal />
        </div>
      )}
      {notice && <div className="notice-banner" data-testid="notice-banner">{notice}</div>}
      <Composer />
      <StatusBar />
    </div>
  );
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
