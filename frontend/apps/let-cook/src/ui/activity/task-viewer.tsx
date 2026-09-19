/**
 * Read-only viewer for one row of the tasks list (`views/tasks_pane.rs` `[view]`).
 *
 * A background command opens on its captured stdout (`show_bg_task_viewer` → block viewer,
 * follow-mode while it runs). A subagent opens on its own transcript, streamed under the child
 * session id, falling back to the agent's snapshot when this window attached mid-run.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useActivityStore, isLive, type ActivityItem } from "../../state/activity";
import { getSubagent, type SubagentListItem } from "../../acp/activity";
import { useSessionStore } from "../../state/session";
import { Dialog } from "../components/dialog";
import { formatDuration } from "../chat/format-duration";
import { Markdown } from "../chat/markdown";
import { ThinkingRow, ToolRow, VerbGroupRow } from "../chat/tool-card";
import { projectTranscript } from "../chat/transcript-projection";
import { useNowTick } from "./activity-row";
import { useChildTranscript, useViewingRow } from "./use-activity-rows";

/** How often an open viewer re-reads the agent, so a running task's stdout keeps growing. */
const POLL_MS = 1500;

export function TaskViewer() {
  const row = useViewingRow();
  if (!row) return null;
  return <TaskViewerContent key={`${row.kind}:${row.id}`} row={row} />;
}

function TaskViewerContent({ row }: { row: ActivityItem }) {
  const clearViewing = useActivityStore((state) => state.clearViewing);
  const now = useNowTick();
  const elapsed = Math.max(0, (row.endedAt ?? now) - row.startedAt);
  const live = isLive(row.status);

  return (
    <Dialog
      title={row.name}
      description={
        <span className="task-viewer-meta" data-testid="task-viewer-meta">
          <span className={`task-viewer-status task-viewer-status-${row.status.toLowerCase()}`}>{row.status}</span>
          {` · ${formatDuration(elapsed)}`}
          {row.activityLabel && live && ` · ${row.activityLabel}`}
        </span>
      }
      onClose={clearViewing}
      size="wide"
    >
      <div className="task-viewer" data-testid="task-viewer">
        {row.kind === "subagent" ? <SubagentBody row={row} /> : <TaskOutputBody row={row} />}
      </div>
    </Dialog>
  );
}

/** A background command's stdout, the way the block viewer paints it. */
function TaskOutputBody({ row }: { row: ActivityItem }) {
  const sessionId = useSessionStore((state) => state.sessionId);
  const refreshFromAgent = useActivityStore((state) => state.refreshFromAgent);
  const body = useRef<HTMLPreElement>(null);
  const live = isLive(row.status);

  // The snapshot is the only live stdout channel the wire offers for a background command, and the
  // shell fills it from its own terminal while the task runs (`adapter.rs::list_tasks`).
  useEffect(() => {
    if (!sessionId || !live) return;
    void refreshFromAgent(sessionId);
    const timer = window.setInterval(() => void refreshFromAgent(sessionId), POLL_MS);
    return () => window.clearInterval(timer);
  }, [sessionId, live, refreshFromAgent]);

  useEffect(() => {
    const node = body.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [row.output]);

  return (
    <>
      {row.detail && <p className="task-viewer-command" data-testid="task-viewer-command">{row.detail}</p>}
      <pre className="task-viewer-output" data-testid="task-viewer-output" ref={body}>{row.output ?? ""}</pre>
      {!row.output && <p className="task-viewer-empty">{live ? "No output yet." : "No output."}</p>}
      {row.truncated && (
        <p className="task-viewer-note">
          Output is truncated{row.outputFile ? `; the full log is at ${row.outputFile}` : ""}.
        </p>
      )}
    </>
  );
}

/** A subagent's own transcript, the rows the parent chat paints. */
function SubagentBody({ row }: { row: ActivityItem }) {
  const transcript = useChildTranscript(row.childSessionId);
  const [snapshot, setSnapshot] = useState<SubagentListItem | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const live = isLive(row.status);
  const blocks = useMemo(() => projectTranscript(transcript?.blocks ?? []), [transcript]);

  // A window that attached after the spawn has no streamed blocks, so fall back to the snapshot.
  useEffect(() => {
    let cancelled = false;
    void getSubagent(row.id)
      .then((value) => { if (!cancelled) setSnapshot(value); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [row.id, live]);

  useEffect(() => {
    const node = body.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [blocks.length, row.activityLabel]);

  return (
    <>
      {row.detail && <p className="task-viewer-command" data-testid="task-viewer-command">{row.detail}</p>}
      <div className="task-viewer-transcript" data-testid="task-viewer-transcript" ref={body}>
        {blocks.length > 0 ? (
          blocks.map((block) => (
            <div className="transcript-row" key={block.id}>
              {block.type === "message"
                ? block.role === "thought"
                  ? <ThinkingRow block={block} />
                  : <article className="message message-assistant"><div className="message-body"><Markdown text={block.text} streaming={block.streaming} /></div></article>
                : block.type === "verb-group" ? <VerbGroupRow tools={block.tools} />
                  : block.type === "tool" ? <ToolRow tool={block.tool} />
                    : block.type === "session-event" ? <div className="session-event">{block.text}</div>
                      : null}
            </div>
          ))
        ) : (
          <p className="task-viewer-empty">Nothing streamed to this window yet.</p>
        )}
      </div>
      {snapshot && (
        <div className="task-viewer-snapshot" data-testid="task-viewer-snapshot">
          {snapshot.toolsUsed && snapshot.toolsUsed.length > 0 && (
            <p>Tools: {snapshot.toolsUsed.join(", ")}</p>
          )}
          {(snapshot.turnCount !== undefined || snapshot.toolCallCount !== undefined) && (
            <p>
              {snapshot.turnCount !== undefined && `${snapshot.turnCount} turns`}
              {snapshot.turnCount !== undefined && snapshot.toolCallCount !== undefined && " · "}
              {snapshot.toolCallCount !== undefined && `${snapshot.toolCallCount} tool calls`}
            </p>
          )}
          {snapshot.output && <pre className="task-viewer-output">{snapshot.output}</pre>}
        </div>
      )}
    </>
  );
}
