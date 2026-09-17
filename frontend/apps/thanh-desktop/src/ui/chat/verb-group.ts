import type { ToolBlock } from "../../state/session";
import { isTerminalToolStatus } from "./transcript-projection";

/**
 * Eagerly folded kinds, from `scrollback/blocks/tool/mod.rs::verb_group_kind`.
 * Command / EditFile / McpCall / Message / OtherTool are *not* here: they keep their own rows and
 * only ever appear in a truncation header, never in a verb run.
 */
export type VerbKind =
  | "file"
  | "skill"
  | "search"
  | "dir"
  | "fetch"
  | "websearch"
  | "memory"
  | "mcpsearch"
  | "subagent";

interface Vocabulary {
  running: string;
  done: string;
  one: string;
  many: string;
}

const VOCABULARY: Record<VerbKind, Vocabulary> = {
  file: { running: "Reading", done: "Read", one: "file", many: "files" },
  skill: { running: "Reading", done: "Read", one: "skill", many: "skills" },
  search: { running: "Searching", done: "Searched", one: "pattern", many: "patterns" },
  dir: { running: "Listing", done: "Listed", one: "dir", many: "dirs" },
  fetch: { running: "Fetching", done: "Fetched", one: "website", many: "websites" },
  websearch: { running: "Searching", done: "Searched", one: "website", many: "websites" },
  memory: { running: "Searching", done: "Searched", one: "memory", many: "memories" },
  mcpsearch: { running: "Searching", done: "Searched", one: "MCP tool", many: "MCP tools" },
  subagent: { running: "Running", done: "Ran", one: "subagent", many: "subagents" },
};

/** The foldable kind of a tool call, or `null` when it keeps its own row. */
export function verbKind(tool: ToolBlock): VerbKind | null {
  const kind = (tool.kind ?? "").toLowerCase();
  const title = tool.title ?? "";
  if (/^subagent\b|^task\b/i.test(title) || kind === "task" || kind === "subagent") return "subagent";
  if (/^skill\b/i.test(title) || kind === "skill") return "skill";
  if (/^memory search/i.test(title) || kind === "memory_search") return "memory";
  if (/^search tools/i.test(title) || kind === "search_tool") return "mcpsearch";
  if (/^web search/i.test(title) || kind === "web_search") return "websearch";
  if (/^web fetch/i.test(title) || /^fetch\b/i.test(title) || kind === "web_fetch") return "fetch";
  if (/^list\b/i.test(title) || ["list", "list_dir", "list_directory"].includes(kind)) return "dir";
  if (/^search\b/i.test(title) || ["search", "grep", "glob"].includes(kind)) return "search";
  if (/^read\b/i.test(title) || kind === "read") return "file";
  if (kind === "fetch") return "fetch";
  return null;
}

/**
 * Aggregated header for one verb run (`verb_group.rs::verb_group_header_label`).
 * Buckets keep first-appearance order, tense follows whether that bucket still has a running
 * member, and failures append ` · N failed`.
 */
export function verbGroupLabel(tools: readonly ToolBlock[]): string {
  const buckets = new Map<VerbKind, { running: number; done: number; failed: number }>();
  for (const tool of tools) {
    const kind = verbKind(tool);
    if (!kind) continue;
    const bucket = buckets.get(kind) ?? { running: 0, done: 0, failed: 0 };
    const status = tool.status.toLowerCase();
    if (status === "failed" || status === "error") bucket.failed += 1;
    else if (isTerminalToolStatus(status)) bucket.done += 1;
    else bucket.running += 1;
    buckets.set(kind, bucket);
  }

  const parts: string[] = [];
  let failed = 0;
  for (const [kind, bucket] of buckets) {
    failed += bucket.failed;
    const count = bucket.running + bucket.done + bucket.failed;
    if (count === 0) continue;
    const vocabulary = VOCABULARY[kind];
    const verb = bucket.running > 0 ? vocabulary.running : vocabulary.done;
    parts.push(`${verb} ${count} ${count === 1 ? vocabulary.one : vocabulary.many}`);
  }
  const label = parts.join(", ");
  if (!label) return "";
  return failed > 0 ? `${label} · ${failed} failed` : label;
}
