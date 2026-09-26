import type { FilePreview, GitStatusSummary, ReviewSnapshot, WorkspaceEntry, WorkspaceIndexEntry } from "../workspace";
import { nextRequestId, notify, request, responses, state } from "./state";
import type { TranscriptBlock } from "../../state/session";
import type { MockPlanFile } from "./types";

const MOCK_PLAN_DIR = "/tmp/cook-demo/.cook/sessions/%2Ftmp%2Fcook-demo/mock-session/plans";
const MOCK_PLAN_NAME = "2026-09-19T14-30-22Z.md";
const MOCK_PLAN_BODY = "# Implementation plan\n\n1. Update the transcript renderer\n2. Verify the desktop flow";

/** The plan file a mocked review belongs to, as the shell's per-episode allocation creates it. */
function seededPlanFile(overrides: Partial<MockPlanFile> = {}): MockPlanFile {
  return {
    name: MOCK_PLAN_NAME,
    title: "Implementation plan",
    path: `${MOCK_PLAN_DIR}/${MOCK_PLAN_NAME}`,
    relativePath: `plans/${MOCK_PLAN_NAME}`,
    sizeBytes: MOCK_PLAN_BODY.length,
    modifiedMs: Date.parse("2026-09-19T14:30:22Z"),
    active: true,
    // The tracked episode is held while plan mode is on, exactly as the agent reports it.
    deletable: false,
    content: MOCK_PLAN_BODY,
    ...overrides,
  };
}

/** Native attachment picker stand-in: whatever the seed declared, or `null` for "not available". */
export function mockPickFiles(): string[] | null {
  return state.pickedFiles.length > 0 ? [...state.pickedFiles] : null;
}

/** `read_file_base64` stand-in for a path the seed declared. */
export function mockReadFilePayload(path: string): { data: string; mediaType: string; size: number } {
  const payload = state.filePayloads[path];
  if (!payload) throw new Error(`${path}: no such file`);
  return { ...payload };
}

export function mockWorkspaceList(relativePath = ""): WorkspaceEntry[] {
  const entries = state.workspace.entries[relativePath];
  if (!entries) throw new Error(`directory not found: ${relativePath || "."}`);
  return structuredClone(entries);
}

/** Flatten the seeded directory tree into the same shape `workspace_index` returns. */
export function mockWorkspaceIndex(_hidden = false): WorkspaceIndexEntry[] {
  const seen = new Set<string>();
  const flat: WorkspaceIndexEntry[] = [];
  for (const entries of Object.values(state.workspace.entries)) {
    for (const entry of entries) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      flat.push({ path: entry.path, kind: entry.kind });
    }
  }
  flat.sort((left, right) => {
    const kind = Number(left.kind !== "directory") - Number(right.kind !== "directory");
    if (kind !== 0) return kind;
    return left.path.localeCompare(right.path, undefined, { sensitivity: "base" });
  });
  return structuredClone(flat);
}

export function mockWorkspaceReadFile(relativePath: string): FilePreview {
  const preview = state.workspace.files[relativePath];
  if (!preview) throw new Error(`file not found: ${relativePath}`);
  return structuredClone(preview);
}

export function mockWorkspaceReview(): ReviewSnapshot {
  return activeReview();
}

/**
 * The working tree the workspace commands answer for. The open conversation's folder selects a
 * seeded tree of its own when the test gave one; otherwise the default review stands in.
 */
function activeReview(): ReviewSnapshot {
  const cwd = state.workspace.cwd ?? null;
  const scoped = cwd ? state.workspace.byCwd?.[cwd] : undefined;
  return structuredClone(scoped ?? state.workspace.review);
}

/** Follow a conversation into its folder, as `session/new` and `session/load` make the host do. */
export function openWorkspaceAt(cwd: unknown): void {
  if (typeof cwd === "string" && cwd.length > 0) state.workspace.cwd = cwd;
}

/**
 * Move the mocked working tree mid-turn. The header chip and the status rail re-probe on their own
 * timers, so a test can watch a live `+N −M` follow the edit instead of only seeing the turn-end
 * snapshot.
 */
export function mockPatchWorkspaceReview(overrides: Partial<ReviewSnapshot>): void {
  state.workspace.review = { ...state.workspace.review, ...overrides };
}

/** Dirty-tree summary derived from the seeded review, so the git chip matches the Review panel. */
export function mockGitStatus(): GitStatusSummary {
  const review = activeReview();
  return {
    isGitRepo: review.isGitRepo,
    branch: review.branch,
    changedFiles: review.files.length,
    additions: review.additions,
    deletions: review.deletions,
    operationInProgress: false,
  };
}

/** Records what the renderer answered to a reverse request (permission / question / elicit). */
export function mockRespond(id: number | string, result: unknown): void {
  responses.push({ id, result, at: Date.now() });
}

/**
 * The machine-wide form of `x.ai/models/update`: the catalog moved on disk, so the payload is
 * empty and the client is expected to re-list rather than adopt an empty catalog.
 */
export function mockModelsUpdate(params: Record<string, unknown> = {}): void {
  notify("_x.ai/models/update", params);
}

/**
 * Ask the renderer for input the way an MCP server would, returning the request id so a test can
 * match the answer.
 */
export function mockElicit(overrides: Record<string, unknown> = {}): number {
  const id = nextRequestId();
  request("x.ai/mcp/elicit", {
    sessionId: "mock-session",
    toolCallId: `mock-tool-${id}`,
    serverName: "filesystem",
    message: "Which directory should I expose?",
    mode: "form",
    requestedSchema: {
      type: "object",
      properties: {
        path: { type: "string", title: "Directory", description: "Absolute path to expose" },
        depth: { type: "integer", title: "Depth" },
      },
      required: ["path"],
    },
    ...overrides,
  }, id);
  return id;
}

export function mockPermission(overrides: Record<string, unknown> = {}): number {
  const id = nextRequestId();
  request("session/request_permission", {
    sessionId: "mock-session",
    toolCall: { title: "Run pnpm test", kind: "execute", content: [{ type: "text", text: "pnpm test" }] },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
    ...overrides,
  }, id);
  return id;
}

/** Default multi-question ask: mixed multi/single select, identical texts, and a long description. */
export const MOCK_MULTI_QUESTIONS = [
  {
    question: "Which approach should I use?\n\nPick the strategy for this change. Prefer the safer path unless speed is mandatory.",
    multiSelect: false,
    options: [
      { id: "safe", label: "Safe change", description: "Smallest diff that preserves behavior" },
      { id: "fast", label: "Fast change", description: "Ship quickly; accept follow-up cleanup" },
    ],
  },
  {
    question: "Which approach should I use?",
    multiSelect: true,
    options: [
      { id: "tests", label: "Add tests", description: "Cover the new paths" },
      { id: "docs", label: "Update docs", description: "Mention the behavior change" },
      { id: "skip", label: "Skip extras", description: "Merge without tests or docs" },
    ],
  },
  {
    question: "Where should we deploy?",
    multiSelect: false,
    options: [
      { id: "staging", label: "Staging" },
      { id: "prod", label: "Production", description: "Only after staging is green" },
    ],
  },
];

export function mockQuestion(overrides: Record<string, unknown> = {}): number {
  const id = nextRequestId();
  request("x.ai/ask_user_question", {
    sessionId: "mock-session",
    questions: MOCK_MULTI_QUESTIONS,
    ...overrides,
  }, id);
  return id;
}

export function mockPlan(overrides: Record<string, unknown> = {}): number {
  const id = nextRequestId();
  // A review belongs to a file on disk: the shell allocates one per episode before it parks the
  // request, so the plan list has to carry it too.
  const current = state.planFiles.find((file) => file.active) ?? seededPlanFile();
  if (!state.planFiles.some((file) => file.path === current.path)) {
    state.planFiles = [...state.planFiles, current];
  }
  request("x.ai/exit_plan_mode", {
    sessionId: "mock-session",
    planContent: MOCK_PLAN_BODY,
    planFilePath: current.path,
    ...overrides,
  }, id);
  return id;
}

/**
 * Ship one `x.ai/session_notification` update the way the shell does (goal updates, relay status):
 * an extension method carrying `{ sessionId, update }`. `sessionId` defaults to this agent's own
 * session, and names another one when a test drives a conversation the window is not showing.
 */
export function mockSessionNotification(update: Record<string, unknown>, sessionId = "mock-session"): void {
  notify("_x.ai/session_notification", { sessionId, update });
}

/** Broadcast `x.ai/queue/changed` for the Desktop queue pane (optionally replace mock rows). */
export function mockQueueChanged(
  entries?: Array<{ id: string; version: number; text: string; kind?: string; position?: number }>,
  sessionId = "mock-session",
  running?: { id: string; text: string; kind?: string },
): void {
  if (entries) {
    state.queueEntries = entries.map((entry, index) => ({
      ...entry,
      position: entry.position ?? index,
    }));
  }
  notify("x.ai/queue/changed", {
    sessionId,
    entries: state.queueEntries.map((entry, index) => ({
      ...entry,
      position: entry.position ?? index,
    })),
    ...(running ? {
      runningPromptId: running.id,
      runningText: running.text,
      runningKind: running.kind ?? "prompt",
    } : {}),
  });
}

/**
 * A real `session/update` under an arbitrary session, `_meta` included — the shape a child session
 * streams its own turn in (a subagent carries its own `promptId`, which is not the parent's).
 */
export function mockSessionUpdate(
  sessionId: string,
  update: Record<string, unknown>,
  meta: Record<string, unknown> = {},
): void {
  notify("session/update", { sessionId, update, ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}) });
}

/** Seed consecutive transcript blocks for browser tests that the ACP reducer cannot produce. */
export async function mockSeedTranscript(blocks: TranscriptBlock[], childSessionId?: string): Promise<void> {
  if (childSessionId) {
    const { useActivityStore } = await import("../../state/activity/store");
    useActivityStore.getState().setChildTranscript(childSessionId, {
      blocks,
      cursor: { turnId: null, assistantId: null, thoughtId: null, optimisticUserId: null },
    });
    return;
  }
  const { useSessionStore } = await import("../../state/session/store");
  useSessionStore.getState().set({ blocks });
}

/** Ext notif helpers for activity panel tests (SessionNotification envelope). */
export function mockTaskBackgrounded(overrides: Record<string, unknown> = {}): void {
  const snapshot = {
    task_id: "task-1",
    command: "sleep 30",
    cwd: "/tmp",
    output: "",
    output_file: "/tmp/out.log",
    completed: false,
    description: "Wait for server",
    ...overrides,
  };
  // `x.ai/task/list` reads this, so an open viewer's polling sees the same task the notif announced.
  state.tasks = [...(state.tasks ?? []).filter((task) => task.task_id !== snapshot.task_id), snapshot];
  notify("_x.ai/task_backgrounded", {
    sessionId: "mock-session",
    update: {
      sessionUpdate: "task_backgrounded",
      tool_call_id: "tc-1",
      ...snapshot,
    },
  });
}

/** Grow a mocked background task's stdout, the way the shell's live terminal/output does. */
export function mockTaskOutput(taskId: string, output: string): void {
  state.tasks = (state.tasks ?? []).map((task) =>
    task.task_id === taskId ? { ...task, output } : task,
  );
}

export function mockTaskCompleted(overrides: Record<string, unknown> = {}): void {
  const snapshot = {
    task_id: "task-1",
    command: "sleep 30",
    cwd: "/tmp",
    output: "",
    output_file: "/tmp/out.log",
    truncated: false,
    completed: true,
    exit_code: 0,
    description: "Wait for server",
    is_backgrounded: true,
    ...(isRecord(overrides.task_snapshot) ? overrides.task_snapshot : {}),
  };
  // The real agent lists a finished task too, so a later `x.ai/task/list` must not resurrect it.
  state.tasks = (state.tasks ?? []).map((task) =>
    task.task_id === snapshot.task_id ? { ...task, ...snapshot } : task,
  );
  notify("_x.ai/task_completed", {
    sessionId: "mock-session",
    update: {
      sessionUpdate: "task_completed",
      will_wake: false,
      task_snapshot: snapshot,
      ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "task_snapshot")),
    },
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A goal snapshot with the wire's required fields; callers override what they exercise. */
export function goalUpdate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionUpdate: "goal_updated",
    goal_id: "goal-1",
    objective: "Ship the desktop goal surface",
    status: "active",
    phase: "executing",
    tokens_used: 0,
    elapsed_ms: 0,
    total_deliverables: 0,
    completed_deliverables: 0,
    total_worker_rounds: 0,
    total_verify_rounds: 0,
    token_baseline: 0,
    finished_subagent_tokens: 0,
    ...overrides,
  };
}

export function splitReply(reply: string): string[] {
  const midpoint = Math.max(1, Math.floor(reply.length / 2));
  return [reply.slice(0, midpoint), reply.slice(midpoint)].filter(Boolean);
}
