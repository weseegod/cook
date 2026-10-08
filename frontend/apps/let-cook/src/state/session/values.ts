import type { ToolBlock } from "./types";

/**
 * Normalized `ToolBlock.kind` vocabulary. The ACP kind (`read`/`search`/…), the canonical
 * `x.ai/tool.kind` (`read`/`list_dir`/`web_search`/…), and a wire name (`read_file`, `grep`) all
 * collapse onto these, so the verb fold and the collapsed header do not depend on which of the
 * three the agent happened to send.
 */
export type NormalizedToolKind =
  | "read"
  | "edit"
  | "write"
  | "list"
  | "search"
  | "execute"
  | "fetch"
  | "web_search"
  | "memory_search"
  | "search_tool"
  | "use_tool"
  | "skill"
  | "subagent"
  | "other";

const CANONICAL_KINDS: Record<string, NormalizedToolKind> = {
  read: "read",
  edit: "edit",
  write: "write",
  delete: "edit",
  move: "edit",
  list: "list",
  list_dir: "list",
  list_directory: "list",
  search: "search",
  grep: "search",
  glob: "search",
  lsp: "read",
  execute: "execute",
  web_search: "web_search",
  web_fetch: "fetch",
  memory_search: "memory_search",
  memory_get: "read",
  skill: "skill",
  task: "subagent",
  search_tool: "search_tool",
  use_tool: "use_tool",
};

/** Wire tool names whose kind the agent sometimes omits (`x.ai/tool.kind` is authoritative). */
const WIRE_KIND_NAMES: Record<string, NormalizedToolKind> = {
  read_file: "read",
  cursor_read: "read",
  grep: "search",
  grep_search: "search",
  glob: "search",
  list_dir: "list",
  list_directory: "list",
  search_replace: "edit",
  apply_patch: "edit",
  hashline_edit: "edit",
  edit: "edit",
  write: "write",
  bash: "execute",
  run_terminal_command: "execute",
  run_terminal_cmd: "execute",
  web_fetch: "fetch",
  web_search: "web_search",
  x_search: "web_search",
  memory_search: "memory_search",
  skill: "skill",
  search_tool: "search_tool",
  use_tool: "use_tool",
  task: "subagent",
};

interface CanonicalToolMeta {
  kind?: string;
  name?: string;
  /** Projected `input` dict: `path`, `pattern`, `directory`, `command` (`normalization.rs::canonical_input`). */
  input?: Record<string, unknown>;
}

/**
 * `_meta["x.ai/tool"]` (`tool_taxonomy.rs::CanonicalToolMeta`) from either the tool-call's own
 * `_meta` or the session notification envelope. Present on the early `tool_call`, before the
 * refined kind arrives.
 */
export function canonicalToolMeta(
  raw: Record<string, unknown>,
  envelope?: Record<string, unknown> | null,
): CanonicalToolMeta | null {
  const sources = [asRecord(raw._meta), envelope ? asRecord(envelope._meta) : null, asRecord(raw.meta)];
  for (const source of sources) {
    const meta = source ? asRecord(source["x.ai/tool"]) : null;
    if (!meta) continue;
    return {
      kind: stringOr(meta.kind),
      name: stringOr(meta.name),
      input: asRecord(meta.input) ?? undefined,
    };
  }
  return null;
}

/**
 * Collapse every kind spelling onto {@link NormalizedToolKind}. `null` when nothing classifies
 * the tool, so the caller keeps its existing value.
 */
export function normalizeToolKind(
  raw: Record<string, unknown>,
  envelope?: Record<string, unknown> | null,
): NormalizedToolKind | null {
  const canonical = canonicalToolMeta(raw, envelope);
  const candidates = [
    canonical?.kind,
    stringOr(raw.kind),
    canonical?.name,
    stringOr(raw.title),
  ];
  for (const candidate of candidates) {
    const kind = matchToolKind(candidate);
    if (kind) return kind;
  }
  return null;
}

/** Generic kinds that classify nothing: fall through to the next candidate. */
const GENERIC_KINDS = new Set(["other", "unknown", "think", "plan", "switch_mode", "tool"]);

function matchToolKind(value: string | undefined): NormalizedToolKind | null {
  if (!value) return null;
  const key = value.trim().toLowerCase();
  if (GENERIC_KINDS.has(key)) return null;
  const direct = CANONICAL_KINDS[key] ?? WIRE_KIND_NAMES[key];
  if (direct) return direct;
  return TITLE_KINDS.find(([pattern]) => pattern.test(key))?.[1] ?? null;
}

/** Refined ACP titles (`Read \`path\``, `List \`dir\``, `Web search: "q"`, `Skill: x`) the shell builds. */
const TITLE_KINDS: ReadonlyArray<readonly [RegExp, NormalizedToolKind]> = [
  [/^subagent\b|^task\b/, "subagent"],
  [/^skill\b|^skill:/, "skill"],
  [/^memory search/, "memory_search"],
  [/^search tools/, "search_tool"],
  [/^web search|^x search/, "web_search"],
  [/^web fetch|^fetch\b/, "fetch"],
  [/^list\b/, "list"],
  [/^search\b/, "search"],
  [/^read\b/, "read"],
  [/^(edit|creating)\b/, "edit"],
];

export function isTurnActivity(kind: string): boolean {
  return [
    "user_message_chunk",
    "agent_message_chunk",
    "agent_thought_chunk",
    "tool_call",
    "tool_call_update",
    "plan",
    "plan_update",
  ].includes(kind);
}

export function isTerminalToolStatus(status: string): boolean {
  return ["completed", "complete", "failed", "error", "cancelled", "canceled"].includes(status.toLowerCase());
}

export function toolMetadata(
  raw: Record<string, unknown>,
  previous: ToolBlock | null,
  meta?: CanonicalToolMeta | null,
) {
  const input = asRecord(raw.rawInput) ?? asRecord(raw.input) ?? asRecord(raw.arguments) ?? {};
  const canonicalInput = meta?.input ?? {};
  const command = firstString(
    raw.command,
    input.command,
    canonicalInput.command,
    previous?.command,
  );
  const description = firstString(raw.description, input.description, previous?.description);
  const bashMode = bashModeFlag(raw) ?? previous?.bashMode;
  const paths = uniqueStrings([
    ...stringArray(raw.paths),
    ...stringArray(raw.locations),
    ...stringArray(input.paths),
    ...stringArray(input.path),
    ...stringArray(input.filePath),
    ...stringArray(canonicalInput.path),
    ...stringArray(canonicalInput.directory),
    ...(previous?.paths ?? []),
  ]);
  return { command, description, bashMode, paths };
}

/**
 * The user-`!` marker the shell stamps into the tool-call's own `_meta` (`tracker.rs` reads
 * `_meta.bash_mode`). Only a real `true` counts; absent means an agent command.
 */
function bashModeFlag(raw: Record<string, unknown>): boolean | undefined {
  for (const source of [asRecord(raw._meta), asRecord(raw.meta)]) {
    if (source && source.bash_mode === true) return true;
  }
  return undefined;
}

export function toolContent(raw: Record<string, unknown>, previous: ToolBlock | null): unknown[] {
  if (Array.isArray(raw.content)) return raw.content;
  const delta = firstString(raw.outputDelta, raw.contentDelta, raw.delta);
  if (!delta) return previous?.content ?? [];
  const content = [...(previous?.content ?? [])];
  const last = asRecord(content.at(-1));
  const lastValue = last ? asRecord(last.content) : null;
  if (last?.type === "content" && lastValue?.type === "text" && typeof lastValue.text === "string") {
    content[content.length - 1] = { ...last, content: { ...lastValue, text: `${lastValue.text}${delta}` } };
    return content;
  }
  return [...content, { type: "content", content: { type: "text", text: delta } }];
}

export function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

export function stringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    const record = asRecord(item);
    return record ? [firstString(record.path, record.filePath, record.uri)].filter((item): item is string => Boolean(item)) : [];
  });
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function contentImage(content: Record<string, unknown> | null): string | null {
  return content?.type === "image" && typeof content.data === "string"
    ? `data:${String(content.mimeType ?? "image/png")};base64,${content.data}`
    : null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function stringOr(value: unknown, fallback?: string): string | undefined {
  return typeof value === "string" ? value : fallback;
}

export function numberOr(value: unknown, fallback: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
