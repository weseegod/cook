/**
 * One subagent's own view (`app/agent_view/subagent_takeover.rs`): the TUI replaces the whole agent
 * draw with the child's framed transcript and its own turn-status. Desktop replaces the chat column
 * the same way, and the child's rows go through the same `TranscriptPane` as the parent's, so a
 * spawn — the `/goal` planner above all — reads exactly like the main chat.
 *
 * Everything the parent owns stays out: the composer submits on the parent session, permissions/plan
 * review are reverse requests the parent answers, and the TUI's takeover has no prompt of its own —
 * a child is spoken to by the parent's `send_subagent_message` row, not from inside this view.
 */
import { useEffect, useMemo, useState } from "react";
import { Check, LoaderCircle, Minus, X } from "lucide-react";
import { isLive, useActivityStore, type ActivityItem } from "../../state/activity";
import type { TranscriptBlock } from "../../state/session";
import { useChildTranscript, useViewingRow } from "../activity/use-activity-rows";
import { formatDuration } from "./format-duration";
import { TranscriptPane } from "./transcript-pane";
import { TurnStatusRow, usePhaseClock } from "./turn-status";
import { deriveActivity, phaseKey } from "./turn-activity";
import { useSpinFrame } from "./use-spin-frame";

export function SubagentTakeover() {
  const row = useViewingRow();
  if (!row) return null;
  return <SubagentView key={`${row.kind}:${row.id}`} row={row} />;
}

function SubagentView({ row }: { row: ActivityItem }) {
  const clearViewing = useActivityStore((state) => state.clearViewing);
  const transcript = useChildTranscript(row.childSessionId);
  const live = isLive(row.status);
  // A finished child has nothing running (`subagent.rs::finalize_finished_child_view` →
  // `scrollback.finish_all_running`), so its last assistant row must not keep a streaming caret
  // and it has no live phase to report.
  const blocks = useMemo(() => {
    const delivered = transcript?.blocks ?? [];
    return live ? delivered : delivered.map(finishStreaming);
  }, [transcript, live]);
  const activity = useMemo(() => live ? deriveActivity(blocks) : null, [blocks, live]);
  const phaseStartedAt = usePhaseClock(phaseKey(activity));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      clearViewing();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [clearViewing]);

  const { label, description } = subagentTitle(row);
  const elapsed = formatDuration(Math.max(0, (row.endedAt ?? now) - row.startedAt));
  const tone = live ? "running" : completed(row.status) ? "completed" : "failed";
  const tick = useSpinFrame(live);

  return (
    <div className="subagent-takeover" data-testid="subagent-takeover">
      <header className="subagent-frame" data-testid="subagent-frame">
        <span className={`subagent-frame-icon subagent-frame-icon-${tone}`} aria-hidden="true">
          {live
            ? <LoaderCircle size={12} className="spin" />
            : completed(row.status) ? <Check size={12} /> : <X size={12} />}
        </span>
        <span className={`subagent-frame-type subagent-frame-type-${tone}`}>{label}</span>
        <strong className="subagent-frame-desc" title={description}>{description}</strong>
        {live && row.activityLabel && <span className="subagent-frame-activity">· {row.activityLabel}</span>}
        <span className="subagent-frame-elapsed">{elapsed}</span>
        <button
          type="button"
          className="icon-button subagent-frame-close"
          onClick={clearViewing}
          aria-label="Hide agent view"
          title="Hide"
          data-testid="subagent-close"
        >
          <Minus size={14} />
        </button>
      </header>
      <TranscriptPane
        blocks={blocks}
        live={live}
        empty={<p className="subagent-empty">Nothing streamed to this agent yet.</p>}
      >
        {activity && <TurnStatusRow activity={activity} phaseStartedAt={phaseStartedAt} tick={tick} />}
      </TranscriptPane>
    </div>
  );
}

/** `[type] description` tag-stripping and the capitalized type label (`subagent.rs::format_subagent_label`). */
export function subagentTitle(row: ActivityItem): { label: string; description: string } {
  const { tag, rest } = parseTagPrefix(row.name);
  const type = (row.detail ?? "").trim();
  const raw = type && type !== "general-purpose" ? type : tag ?? "general";
  return { label: capitalize(raw), description: rest || row.name };
}

function parseTagPrefix(value: string): { tag: string | null; rest: string } {
  if (!value.startsWith("[")) return { tag: null, rest: value };
  const close = value.indexOf("]");
  if (close < 0) return { tag: null, rest: value };
  const tag = value.slice(1, close).trim();
  if (!tag) return { tag: null, rest: value };
  return { tag, rest: value.slice(close + 1).trimStart() };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function completed(status: string): boolean {
  return ["completed", "complete", "done"].includes(status.toLowerCase());
}

/** The TUI's `finish_all_running` for a child that has settled: prose stops streaming. */
function finishStreaming(block: TranscriptBlock): TranscriptBlock {
  return block.type === "message" && block.streaming ? { ...block, streaming: false } : block;
}
