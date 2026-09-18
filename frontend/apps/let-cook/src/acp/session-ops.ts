/**
 * Session memory ops: rewind points/execute and session recap.
 *
 * Kept out of `xai.ts` so UI can import these without colliding with other agents'
 * edits there. Wire shapes match the shell extensions (`extensions/rewind.rs`,
 * `extensions/recap.rs`).
 */
import { request } from "./host";
import { normalizeError } from "./errors";

export interface RewindPoint {
  promptIndex: number;
  createdAt: string;
  numFileSnapshots: number;
  hasFileChanges: boolean;
  promptPreview: string | null;
}

export interface RewindExecuteParams {
  sessionId: string;
  targetPromptIndex: number;
  force?: boolean;
  mode?: "all" | "conversation_only" | "files_only";
}

export interface RewindExecuteResult {
  success: boolean;
  targetPromptIndex: number;
  error?: string | null;
  mode?: string | null;
  promptText?: string | null;
  revertedFiles: string[];
  cleanFiles: string[];
}

export interface SessionRecapParams {
  sessionId: string;
  /** `false` for `/recap`; `true` for the automatic away-return path. */
  auto?: boolean;
}

export interface SessionRecapResult {
  ok: boolean;
  disabled?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizePoint(item: Record<string, unknown>): RewindPoint {
  return {
    promptIndex: numberOr(item.promptIndex ?? item.prompt_index),
    createdAt: stringOr(item.createdAt ?? item.created_at),
    numFileSnapshots: numberOr(item.numFileSnapshots ?? item.num_file_snapshots),
    hasFileChanges: item.hasFileChanges === true || item.has_file_changes === true,
    promptPreview: typeof (item.promptPreview ?? item.prompt_preview) === "string"
      ? String(item.promptPreview ?? item.prompt_preview)
      : null,
  };
}

/** `x.ai/rewind/points` — checkpoints the session can rewind to. */
export async function listRewindPoints(sessionId: string): Promise<RewindPoint[]> {
  const value = await request<unknown>("x.ai/rewind/points", { sessionId });
  const record = isRecord(value) ? value : {};
  const raw = record.rewindPoints ?? record.rewind_points;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map(normalizePoint);
}

/** `x.ai/rewind/execute` — rewind to a prompt index. Caller should `session/load` after success. */
export async function executeRewind(params: RewindExecuteParams): Promise<RewindExecuteResult> {
  const value = await request<unknown>("x.ai/rewind/execute", {
    sessionId: params.sessionId,
    targetPromptIndex: params.targetPromptIndex,
    ...(params.force ? { force: true } : {}),
    ...(params.mode ? { mode: params.mode } : {}),
  });
  const record = isRecord(value) ? value : {};
  const revertedFiles = record.revertedFiles ?? record.reverted_files;
  const cleanFiles = record.cleanFiles ?? record.clean_files;
  return {
    success: record.success === true,
    targetPromptIndex: numberOr(record.targetPromptIndex ?? record.target_prompt_index, params.targetPromptIndex),
    error: typeof (record.error) === "string" ? normalizeError(record.error) : null,
    mode: typeof (record.mode) === "string" ? record.mode : null,
    promptText: typeof (record.promptText ?? record.prompt_text) === "string"
      ? String(record.promptText ?? record.prompt_text)
      : null,
    revertedFiles: Array.isArray(revertedFiles)
      ? revertedFiles.map(String)
      : [],
    cleanFiles: Array.isArray(cleanFiles)
      ? cleanFiles.map(String)
      : [],
  };
}

/**
 * `x.ai/recap` — fire-and-forget. The summary arrives later as
 * `sessionUpdate: "session_recap"` (or `session_recap_unavailable`) on
 * `x.ai/session_notification`.
 */
export async function sessionRecap(params: SessionRecapParams): Promise<SessionRecapResult> {
  const value = await request<unknown>("x.ai/recap", {
    sessionId: params.sessionId,
    auto: params.auto === true,
  });
  const record = isRecord(value) ? value : {};
  return {
    ok: record.ok !== false,
    ...(record.disabled === true ? { disabled: true } : {}),
  };
}
