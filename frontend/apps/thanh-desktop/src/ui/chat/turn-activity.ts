/**
 * Turn-status activity model, copied from `xai-grok-pager/src/views/turn_status.rs` +
 * `src/acp/tracker.rs`. Every string here is user-facing chrome the TUI paints verbatim.
 */

/** Max chars for wait/tool description subjects (`tracker.rs::MAX_ACTIVITY_SUBJECT_CHARS`). */
export const MAX_ACTIVITY_SUBJECT_CHARS = 40;

/** First non-empty trimmed line, clamped to {@link MAX_ACTIVITY_SUBJECT_CHARS}. */
export function clampActivitySubject(value: string): string {
  const line = value.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0) ?? value.trim();
  return Array.from(line).slice(0, MAX_ACTIVITY_SUBJECT_CHARS).join("");
}

/** `{subject}…`, or the generic task-output label when there is nothing to name. */
export function formatWaitingForSubject(subject: string): string {
  const clamped = clampActivitySubject(subject);
  return clamped ? `${clamped}…` : "Waiting on task output…";
}

export type WaitingReason =
  | { kind: "model" }
  | { kind: "prompt-ack" }
  | { kind: "subagent"; display?: string }
  | { kind: "task-output"; subject?: string }
  | { kind: "tasks-complete" }
  | { kind: "sleep" }
  | { kind: "hooks"; event: string; count: number };

/** Which muted prefix a tool row carries on the activity line. */
export type ToolVerb = "run" | "search" | "fetch";

export type TurnActivity =
  | { kind: "thinking" }
  | { kind: "responding" }
  | { kind: "cancelling" }
  | { kind: "verifying" }
  | { kind: "compacting" }
  | { kind: "retrying"; attempt: number; headline?: string }
  | { kind: "writing"; label: string }
  | { kind: "waiting"; reason: WaitingReason }
  | { kind: "tool"; title: string; verb: ToolVerb; description?: string; query?: string; url?: string; command?: string }
  | { kind: "ask"; detail: string }
  | { kind: "command"; displayName: string }
  | { kind: "starting-session" }
  | { kind: "bash" }
  | { kind: "unknown" };

/** Label split so the view can mute the verb and highlight the subject. */
export interface ActivityParts {
  prefix?: string;
  subject?: string;
  text: string;
}

export function activityParts(activity: TurnActivity): ActivityParts {
  switch (activity.kind) {
    case "cancelling":
      return { text: "Cancelling…" };
    case "verifying":
      return { text: "Verifying…" };
    case "thinking":
      return { text: "Thinking…" };
    case "responding":
      return { text: "Responding…" };
    case "compacting":
      return { text: "Compacting…" };
    case "retrying": {
      const headline = activity.headline ? ` ${activity.headline}` : "";
      return { text: `Retrying (attempt ${activity.attempt})...${headline}` };
    }
    case "writing":
      return { text: activity.label };
    case "waiting":
      return { text: waitingLabel(activity.reason) };
    case "tool":
      return toolParts(activity);
    case "ask":
      return { text: `Waiting on answers for ${clampActivitySubject(activity.detail)}` };
    case "command":
      return { text: `${activity.displayName}…` };
    case "starting-session":
      return { text: "Starting session…" };
    case "bash":
      return { text: "Running…" };
    case "unknown":
      return { text: "Waiting…" };
  }
}

export function activityText(activity: TurnActivity): string {
  const parts = activityParts(activity);
  return `${parts.prefix ?? ""}${parts.subject ?? ""}` || parts.text;
}

function waitingLabel(reason: WaitingReason): string {
  switch (reason.kind) {
    case "model":
      return "Waiting for response…";
    case "prompt-ack":
      return "Waiting for the agent to accept the prompt…";
    case "subagent": {
      const display = reason.display ? clampActivitySubject(reason.display) : "";
      return display ? `${display}…` : "Waiting on subagent…";
    }
    case "task-output":
      return formatWaitingForSubject(reason.subject ?? "");
    case "tasks-complete":
      return "Waiting on tasks…";
    case "sleep":
      return "Sleeping…";
    case "hooks":
      return reason.count > 1
        ? `Running ${reason.count} ${reason.event} hooks…`
        : `Running ${reason.event} hook…`;
  }
}

function toolParts(activity: Extract<TurnActivity, { kind: "tool" }>): ActivityParts {
  if (activity.description && activity.description.trim()) {
    return { text: `${clampActivitySubject(activity.description)}…` };
  }
  if (activity.verb === "search") {
    const subject = activity.query ?? activity.title;
    return { prefix: "Search ", subject, text: `Search ${subject}` };
  }
  if (activity.verb === "fetch") {
    const subject = activity.url ?? activity.title;
    return { prefix: "Fetch ", subject, text: `Fetch ${subject}` };
  }
  const subject = activity.command ?? activity.title;
  return { prefix: "Run ", subject, text: `Run ${subject}` };
}

/**
 * Spinner phase identity: only a new tool **title**, retry attempt/reason, or wait kind
 * starts a new phase. Description churn on the same tool does not reset the phase timer.
 */
export function phaseKey(activity: TurnActivity | null): string | null {
  if (!activity) return null;
  switch (activity.kind) {
    case "thinking":
    case "responding":
    case "compacting":
    case "writing":
      return activity.kind;
    case "retrying":
      return `retrying:${activity.attempt}:${activity.headline ?? ""}`;
    case "tool":
      return `tool:${activity.title}`;
    case "waiting":
      return `waiting:${waitingKey(activity.reason)}`;
    default:
      return activity.kind;
  }
}

function waitingKey(reason: WaitingReason): string {
  switch (reason.kind) {
    case "hooks":
      return `hooks:${reason.event}`;
    default:
      return reason.kind;
  }
}

export function isPhaseTransition(previous: TurnActivity | null, next: TurnActivity | null): boolean {
  return phaseKey(previous) !== phaseKey(next);
}

/** Waits where Enter aborts the wait and sends instead of queueing behind it. */
export function isSendableWait(activity: TurnActivity | null): boolean {
  if (!activity || activity.kind !== "waiting") return false;
  return ["subagent", "task-output", "tasks-complete", "sleep"].includes(activity.reason.kind);
}

/** Activity labels shown while tool-call arguments stream (`tracker.rs::WritingToolCall::label`). */
export function writingToolCallLabel(toolName: string | undefined, ordinal = 1): string {
  const suffix = ordinal > 1 ? ` (${ordinal})` : "";
  const name = (toolName ?? "").toLowerCase();
  if (name.includes("task") || name.includes("subagent")) return `Writing subagent prompt${suffix}…`;
  if (name.includes("use_tool")) return `Preparing MCP tool${suffix}…`;
  if (name.includes("search_tool")) return `Searching MCP tools${suffix}…`;
  if (name === "write" || name.includes("write_file")) return `Writing file${suffix}…`;
  if (name === "edit" || name.includes("edit")) return `Writing edit${suffix}…`;
  if (name === "execute" || name.includes("bash") || name.includes("shell")) return `Writing command${suffix}…`;
  if (name === "plan") return `Updating todo list${suffix}…`;
  if (name.includes("workflow")) return `Writing workflow${suffix}…`;
  if (name.includes("ask")) return `Preparing question${suffix}…`;
  return toolName ? `Preparing ${toolName}${suffix}…` : "Preparing tool call…";
}

/** Structural view of a transcript row, so the derivation does not depend on the store module. */
export interface ActivitySourceBlock {
  type: string;
  role?: string;
  streaming?: boolean;
  status?: string;
  title?: string;
  kind?: string;
  command?: string;
  description?: string;
  turnId?: string;
}

const TERMINAL_TOOL_STATUSES = ["completed", "complete", "failed", "error", "cancelled", "canceled"];

/**
 * Which activity the transcript currently shows, in the tracker's priority order
 * (`AcpUpdateTracker::activity`): a running tool, else streaming thinking, else streaming prose.
 * Returns `null` when the turn has closed or nothing is streaming — the caller falls back to
 * `Waiting for response…` while a turn is open, exactly like `resolve_turn_activity`.
 *
 * The ACP stream this client receives carries no wait-kind/hook/retry telemetry, so those
 * priorities have no source here; inventing them would be chrome the agent never sent.
 */
export function deriveActivity(blocks: readonly ActivitySourceBlock[]): TurnActivity | null {
  if (blocks.at(-1)?.type === "session-event") return null;

  // The reducer normally makes these states mutually exclusive, but keeping the priority here
  // makes replay and out-of-order ACP batches paint the same activity as the TUI tracker.
  const thought = [...blocks].reverse().find((block) => block.type === "message" && block.role === "thought" && block.streaming);
  if (thought) return { kind: "thinking" };

  const pendingTool = blocks.find((block) => block.type === "tool" && !TERMINAL_TOOL_STATUSES.includes((block.status ?? "").toLowerCase()));
  if (pendingTool?.type === "tool") return toolActivity(pendingTool);

  const assistant = [...blocks].reverse().find((block) => block.type === "message" && block.role === "assistant" && block.streaming);
  if (assistant) return { kind: "responding" };
  return null;
}

function toolActivity(block: ActivitySourceBlock): TurnActivity {
  const title = block.title ?? "";
  if (/^ask[:\s]/i.test(title)) {
    return { kind: "ask", detail: block.description ?? title.replace(/^ask[:\s]+/i, "") };
  }
  return {
    kind: "tool",
    title,
    verb: toolVerb(title),
    description: block.description,
    command: block.command,
  };
}

function toolVerb(title: string): ToolVerb {
  if (/web[_ ]?search|x[_ ]?search/i.test(title)) return "search";
  if (/web[_ ]?fetch/i.test(title)) return "fetch";
  return "run";
}
