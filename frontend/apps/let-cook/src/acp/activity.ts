/**
 * C-task-*, C-sub-*, C-sched-del wrappers for the compact activity panel (map §10 TK-*).
 *
 * Agent params are camelCase (`sessionId`, `taskId`, `subagentId`); list payloads nest
 * snake_case snapshots from the tools crate.
 */
import { request } from "./host";

export type UnknownRecord = Record<string, unknown>;

export interface TaskListItem {
  taskId: string;
  command: string;
  displayCommand?: string;
  description?: string;
  cwd?: string;
  completed: boolean;
  exitCode?: number | null;
  signal?: string | null;
  kind?: string;
  isBackgrounded?: boolean;
  startedAt?: number;
  durationMs?: number;
  /** Live stdout while the task runs, or the final buffer once it settles (`TaskSnapshot::output`). */
  output?: string;
  outputFile?: string;
  /** `output` is a prefix of the real thing. */
  truncated?: boolean;
}

export interface SubagentListItem {
  subagentId: string;
  parentSessionId?: string;
  childSessionId?: string;
  subagentType?: string;
  description: string;
  status?: string;
  startedAtEpochMs?: number;
  durationMs?: number;
  turnCount?: number;
  toolCallCount?: number;
  tokensUsed?: number;
  toolsUsed?: string[];
  errorCount?: number;
  /** Final report of a finished child (`SubagentSnapshotDto::output`). */
  output?: string;
}

export function listTasks(sessionId: string) {
  return request<{ tasks?: unknown }>("x.ai/task/list", { sessionId }).then((value) =>
    extractArray(value, ["tasks"]).map(normalizeTask),
  );
}

export function killTask(sessionId: string, taskId: string, source?: "clientUi" | "teardown") {
  return request("x.ai/task/kill", {
    sessionId,
    taskId,
    ...(source ? { source } : {}),
  });
}

export function listRunningSubagents(sessionId: string) {
  return request<{ subagents?: unknown }>("x.ai/subagent/list_running", { sessionId }).then((value) =>
    extractArray(value, ["subagents"]).map(normalizeSubagent),
  );
}

export function getSubagent(subagentId: string, opts?: { block?: boolean; timeoutMs?: number }) {
  return request<{ snapshot?: unknown }>("x.ai/subagent/get", {
    subagentId,
    ...(opts?.block !== undefined ? { block: opts.block } : {}),
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  }).then((value) => {
    const snap = isRecord(value) ? value.snapshot : null;
    return isRecord(snap) ? normalizeSubagent(snap) : null;
  });
}

export function cancelSubagent(subagentId: string) {
  return request("x.ai/subagent/cancel", { subagentId });
}

/** Optional dock reply (C-sub-msg). */
export function messageSubagent(subagentId: string, message: string) {
  return request("x.ai/subagent/message", { subagentId, message });
}

export function deleteScheduledTask(sessionId: string, taskId: string) {
  return request("x.ai/scheduler/delete", { sessionId, taskId });
}

/**
 * Ext notifs (`x.ai/task_backgrounded`, scheduled_*, monitor_event) wrap a SessionNotification
 * `{ sessionId, update }`. Flat test payloads pass through unchanged.
 */
export function activityPayload(params: Record<string, unknown>): Record<string, unknown> {
  return isRecord(params.update) ? params.update : params;
}

function extractArray(value: unknown, keys: string[]): UnknownRecord[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [];
}

function normalizeTask(item: UnknownRecord): TaskListItem {
  const start = item.start_time ?? item.startTime ?? item.startedAt;
  return {
    taskId: String(item.task_id ?? item.taskId ?? ""),
    command: String(item.command ?? ""),
    displayCommand: stringValue(item.display_command ?? item.displayCommand),
    description: stringValue(item.description),
    cwd: stringValue(item.cwd),
    completed: item.completed === true,
    exitCode: typeof item.exit_code === "number" ? item.exit_code : typeof item.exitCode === "number" ? item.exitCode : null,
    signal: stringValue(item.signal) ?? null,
    kind: stringValue(item.kind),
    isBackgrounded: item.is_backgrounded === true || item.isBackgrounded === true,
    startedAt: epochMs(start),
    durationMs: numberValue(item.duration_ms ?? item.durationMs),
    output: stringValue(item.output),
    outputFile: stringValue(item.output_file ?? item.outputFile),
    truncated: item.truncated === true,
  };
}

function normalizeSubagent(item: UnknownRecord): SubagentListItem {
  return {
    subagentId: String(item.subagent_id ?? item.subagentId ?? ""),
    parentSessionId: stringValue(item.parent_session_id ?? item.parentSessionId),
    childSessionId: stringValue(item.child_session_id ?? item.childSessionId),
    subagentType: stringValue(item.subagent_type ?? item.subagentType),
    description: String(item.description ?? item.subagent_type ?? item.subagentType ?? "Subagent"),
    status: stringValue(item.status) ?? "running",
    startedAtEpochMs: numberValue(item.started_at_epoch_ms ?? item.startedAtEpochMs),
    durationMs: numberValue(item.duration_ms ?? item.durationMs),
    turnCount: numberValue(item.turn_count ?? item.turnCount),
    toolCallCount: numberValue(item.tool_call_count ?? item.toolCallCount),
    tokensUsed: numberValue(item.tokens_used ?? item.tokensUsed),
    toolsUsed: stringArray(item.tools_used ?? item.toolsUsed),
    errorCount: numberValue(item.error_count ?? item.errorCount),
    output: stringValue(item.output),
  };
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function epochMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}
