/**
 * The session's plan files, as `x.ai/session/plans` reports them.
 *
 * Plan mode allocates one file per planning episode (`<session>/plans/<utc>.md`), publishes it to
 * `<slug>-<utc>.md` when the episode ends, and keeps the
 * legacy `<session>/plan.md` for sessions written before that, so this list is the plan history the
 * desktop header paints. Deleting one goes back through the agent (`x.ai/session/plans/delete`):
 * the renderer never touches the filesystem itself.
 */
import { request } from "./host";
import { normalizeError } from "./errors";

export interface PlanFileSummary {
  /** File name with extension; an episode starts as `<utc>.md` and is published to `<slug>-<utc>.md`. */
  name: string;
  /** H1 from the plan body, or `"Untitled plan"` when the file has no heading. */
  title: string;
  /** Absolute path, for "Copy file path". */
  path: string;
  /** Path relative to the session directory, as `plan_mode.json` records the current episode. */
  relativePath: string;
  sizeBytes: number;
  /** Last write, epoch ms. Request-changes edits in place, so this is not the creation time. */
  modifiedMs: number;
  /** The episode file the session's plan-mode tracker is pointed at. */
  active: boolean;
  /** Whether the agent will accept a delete for this file. */
  deletable: boolean;
  /** File text, `null` when the agent withheld it (oversized or not UTF-8). */
  content: string | null;
}

export interface PlanFilesParams {
  sessionId: string;
  cwd: string;
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

/** Tolerate a payload that spells its fields in snake_case, as the Rust side serializes it. */
function first(record: Record<string, unknown>, camel: string, snake: string): unknown {
  return record[camel] ?? record[snake];
}

function headingFromContent(content: unknown): string | null {
  if (typeof content !== "string") return null;
  for (const line of content.split(/\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("# ") || trimmed.length <= 2) continue;
    let title = trimmed.slice(2).trim();
    if (title.startsWith("Plan:")) {
      const rest = title.slice("Plan:".length).trim();
      if (rest) title = rest;
    }
    return title.length > 0 ? title : null;
  }
  return null;
}

function normalizePlanFile(value: unknown): PlanFileSummary | null {
  if (!isRecord(value)) return null;
  const name = stringOr(first(value, "name", "name"));
  if (name === "") return null;
  const content = first(value, "content", "content");
  const title =
    stringOr(first(value, "title", "title"))
    || headingFromContent(content)
    || "Untitled plan";
  return {
    name,
    title,
    path: stringOr(value.path),
    relativePath: stringOr(first(value, "relativePath", "relative_path")),
    sizeBytes: numberOr(first(value, "sizeBytes", "size_bytes")),
    modifiedMs: numberOr(first(value, "modifiedMs", "modified_ms")),
    active: value.active === true,
    // A payload that predates the flag would otherwise render a dead Delete button.
    deletable: value.deletable !== false,
    content: typeof content === "string" ? content : null,
  };
}

/** `x.ai/session/plans` — the session's plan files, newest first. */
export async function listPlanFiles(params: PlanFilesParams): Promise<PlanFileSummary[]> {
  const value = await request<unknown>("x.ai/session/plans", {
    sessionId: params.sessionId,
    cwd: params.cwd,
  });
  const record = isRecord(value) ? value : {};
  const raw = record.plans;
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizePlanFile).filter((plan): plan is PlanFileSummary => plan !== null);
}

/** `x.ai/session/plans/delete` — remove one plan file. */
export async function deletePlanFile(params: PlanFilesParams & { path: string }): Promise<boolean> {
  const value = await request<unknown>("x.ai/session/plans/delete", {
    sessionId: params.sessionId,
    cwd: params.cwd,
    path: params.path,
  });
  const record = isRecord(value) ? value : {};
  if (record.deleted !== true) throw new Error(normalizeError(record.error, "The plan was not deleted"));
  return true;
}
