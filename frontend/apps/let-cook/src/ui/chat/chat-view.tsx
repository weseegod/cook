import { useCallback, useEffect } from "react";
import { AlertCircle, Bot, Brain, FileCode2, RefreshCw, X } from "lucide-react";
import { acpClient } from "../../acp/client";
import { TaskViewer } from "../activity/task-viewer";
import { useActivityStore } from "../../state/activity";
import { useSessionStore } from "../../state/session";
import { PlanDialog } from "./plan-dialog";
import { PlanFileDialog } from "./plan-file-dialog";
import { PromptSlot } from "./prompt-slot";
import { QueueBar } from "./queue-bar";
import { RecapDialog } from "./recap-dialog";
import { RewindDialog } from "./rewind-dialog";
import { SubagentTakeover } from "./subagent-takeover";
import { TranscriptPane } from "./transcript-pane";
import { TurnStatus } from "./turn-status";

export function ChatView() {
  const blocks = useSessionStore((state) => state.blocks);
  const sessionId = useSessionStore((state) => state.sessionId);
  const turnRunning = useSessionStore((state) => state.turnRunning);
  const connection = useSessionStore((state) => state.connection);
  const cwd = useSessionStore((state) => state.cwd);
  const error = useSessionStore((state) => state.error);
  const setComposerDraft = useSessionStore((state) => state.setComposerDraft);
  // Narrow on purpose: opening a subagent replaces this whole column (the TUI's fullscreen
  // takeover), so the chat must not re-render every time a running child reports activity.
  const subagentOpen = useActivityStore((state) => state.viewing?.kind === "subagent");

  const draft = useCallback((text: string) => setComposerDraft(text), [setComposerDraft]);

  // A job belongs to one conversation, so opening another one drops its viewer: the child's
  // transcript would otherwise keep painting under the new conversation's header.
  useEffect(() => {
    useActivityStore.getState().clearViewing();
  }, [sessionId]);

  if (subagentOpen) return <SubagentTakeover />;

  return (
    <TranscriptPane
      blocks={blocks}
      live={turnRunning}
      empty={<EmptyChat sessionId={sessionId} onDraft={draft} />}
      mainSlot={<PlanDialog />}
    >
      <QueueBar />
      <TurnStatus />
      {error && <ChatError error={error} connection={connection} cwd={cwd} />}
      <PromptSlot />
      <RewindDialog />
      <RecapDialog />
      <PlanFileDialog />
      <TaskViewer />
    </TranscriptPane>
  );
}

function EmptyChat({ sessionId, onDraft }: { sessionId: string | null; onDraft: (text: string) => void }) {
  return (
    <div className="empty-chat">
      <div className="empty-chat-mark"><Bot size={22} /></div>
      <h2>{sessionId ? "What should we work on?" : "Start a conversation"}</h2>
      <p>Ask about this codebase, request a change, or type <kbd>/</kbd> for commands.</p>
      <div className="empty-chat-actions">
        <button type="button" onClick={() => onDraft("Review this project and suggest the next step.")}><FileCode2 size={14} /> Review this project</button>
        <button type="button" onClick={() => onDraft("Explain the architecture of this project.")}><Brain size={14} /> Explain the architecture</button>
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
