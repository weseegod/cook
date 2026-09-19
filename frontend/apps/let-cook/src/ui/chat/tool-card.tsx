import {
  ChevronRight,
  Clipboard,
  Copy,
  FileCode2,
  Files,
  FolderOpen,
  Globe2,
  Search,
  Terminal,
} from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { openPath } from "../../acp/host";
import { normalizeError } from "../../acp/errors";
import { useArtifactStore } from "../../state/artifacts";
import { useSessionStore, type ToolBlock } from "../../state/session";
import { Markdown } from "./markdown";
import { copyText, displayPath } from "./clipboard";
import { formatThinkingDuration } from "./format-duration";
import { isLiveTool, isTerminalToolStatus } from "./transcript-projection";
import { thinkingPreview, type ThinkingPreview } from "./thinking-preview";
import { toolLineCounts } from "./edit-lines";
import { verbGroupLabel } from "./verb-group";

/** Tall edit diffs open in the Preview dock instead of drowning the transcript. */
const TALL_DIFF_LINES = 40;

const EDIT_KINDS = ["edit", "write", "write_file"];

/** The collapsed Edit suffix (`edit.rs::header_line`): a diffstat, else ` ({n} edits)`. */
export type EditSuffix =
  | { kind: "diff"; added: number; removed: number }
  | { kind: "edits"; count: number };

/** Header text for a collapsed tool row (`scrollback/blocks/tool/*`). */
export function toolHeader(tool: ToolBlock): { prefix?: string; text: string; suffix?: EditSuffix } {
  const suffix = editHeaderSuffix(tool);
  const head = (text: string): { prefix?: string; text: string; suffix?: EditSuffix } => (suffix ? { text, suffix } : { text });
  if (tool.description) return head(tool.description);
  if (isExecute(tool) && tool.command) return { prefix: "$ ", text: tool.command };
  const path = tool.paths[0] ? displayPath(tool.paths[0]) : null;
  const kind = (tool.kind ?? "").toLowerCase();
  if (path && isGenericTitle(tool.title, kind)) {
    if (EDIT_KINDS.includes(kind)) return head(`${kind === "write" || kind === "write_file" ? "Creating" : "Edit"} ${path}`);
    if (["list", "list_dir", "list_directory"].includes(kind)) return { text: `List ${path}` };
    if (["read", "file"].includes(kind)) return { text: `Read ${path}` };
  }
  return head(tool.title);
}

/**
 * Counts for the collapsed Edit one-liner. A call that touched several files reports one diff per
 * file, so counts describing only the first would lie and the row falls back to ` ({n} edits)`.
 */
export function editHeaderSuffix(tool: ToolBlock): EditSuffix | null {
  if (!EDIT_KINDS.includes((tool.kind ?? "").toLowerCase())) return null;
  const stats = toolLineCounts(tool.content);
  if (tool.paths.length <= 1 && (stats.added > 0 || stats.removed > 0)) {
    return { kind: "diff", added: stats.added, removed: stats.removed };
  }
  if (stats.hunks > 1) return { kind: "edits", count: stats.hunks };
  return null;
}

function EditSuffixSpans({ suffix }: { suffix: EditSuffix }) {
  if (suffix.kind === "edits") return <span className="row-suffix row-edits">({suffix.count} edits)</span>;
  return (
    <span className="row-suffix row-diffstat">
      <span className="row-diff-add">+{suffix.added}</span>
      <span className="row-diff-sep">/</span>
      <span className="row-diff-del">-{suffix.removed}</span>
    </span>
  );
}

function isGenericTitle(title: string, kind: string): boolean {
  const value = title.trim().toLowerCase();
  return value.length === 0 || value === "tool" || value === kind || ["read", "edit", "write", "list", "file"].includes(value);
}

function isExecute(tool: ToolBlock): boolean {
  return (tool.kind ?? "").toLowerCase() === "execute" || /^(bash|shell|run|execute)\b/i.test(tool.title ?? "");
}

/**
 * A verb-group run: one aggregated header replaces its member rows
 * (`scrollback/state/groups.rs::project_verb_run`). The label rebuilds from status every render.
 */
export function toolPropsEqual(previous: { tool: ToolBlock }, next: { tool: ToolBlock }): boolean {
  return toolVisualEqual(previous.tool, next.tool);
}

function toolVisualEqual(previous: ToolBlock, next: ToolBlock): boolean {
  return previous.id === next.id
    && previous.title === next.title
    && previous.kind === next.kind
    && previous.status === next.status
    && previous.startedAt === next.startedAt
    && previous.elapsedMs === next.elapsedMs
    && previous.command === next.command
    && previous.description === next.description
    && sameArray(previous.paths, next.paths)
    && sameArray(previous.locations, next.locations)
    && sameArray(previous.content, next.content);
}

function sameArray(previous: readonly unknown[], next: readonly unknown[]): boolean {
  return previous.length === next.length && previous.every((value, index) => value === next[index]);
}

export const VerbGroupRow = memo(function VerbGroupRow({ tools }: { tools: ToolBlock[] }) {
  const running = tools.some(isLiveTool);
  const failed = tools.some((tool) => ["failed", "error"].includes(tool.status.toLowerCase()));
  const state = running ? "running" : failed ? "failed" : "completed";
  return (
    <details className={`verb-group verb-${state}`} data-testid="verb-group">
      <summary>
        <span className="row-chevron"><ChevronRight size={13} /></span>
        <span className={`row-bullet${running ? " animated" : ""}`} aria-hidden="true" />
        <strong>{verbGroupLabel(tools)}</strong>
      </summary>
      <div className="verb-group-body">
        {tools.map((tool) => <ToolRow key={tool.id} tool={tool} />)}
      </div>
    </details>
  );
}, (previous, next) => (
  previous.tools.length === next.tools.length
  && previous.tools.every((tool, index) => toolVisualEqual(tool, next.tools[index]))
));

/** One tool block, collapsed by default; no elapsed in the row and no rerun control. */
export const ToolRow = memo(function ToolRow({ tool }: { tool: ToolBlock }) {
  const header = toolHeader(tool);
  const running = isLiveTool(tool);
  // The diffstat belongs to the one-liner: an expanded row shows the hunks themselves.
  const [open, setOpen] = useState(false);
  return (
    <details
      className={`tool-row tool-${running ? "running" : normalizedStatus(tool.status)}`}
      data-testid={`tool-row-${tool.id}`}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="row-chevron"><ChevronRight size={13} /></span>
        <span className={`row-bullet${running ? " animated" : ""}`} aria-hidden="true" />
        <span className="row-icon">{toolIcon(tool)}</span>
        <strong title={tool.title}>
          {header.prefix && <span className="row-prefix">{header.prefix}</span>}
          {header.text}
        </strong>
        {!open && header.suffix && <EditSuffixSpans suffix={header.suffix} />}
      </summary>
      <ToolDetail tool={tool} />
    </details>
  );
}, toolPropsEqual);

/**
 * Thinking row: `Thinking…` plus the last few lines while running, `Thought for 1.2s` with no body
 * once frozen. A running block defaults to the truncated view and finish collapses it
 * (`scrollback/blocks/thinking.rs::default_display_mode` / `finished_display_mode`).
 */
export const ThinkingRow = memo(function ThinkingRow({ block }: { block: { id: string; text: string; streaming: boolean; elapsedMs?: number | null } }) {
  const time = block.elapsedMs ?? null;
  const header = block.streaming ? "Thinking…" : time === null ? "Thought" : `Thought for ${formatThinkingDuration(time)}`;
  const streaming = block.streaming;
  const [expanded, setExpanded] = useState(false);
  // Finish collapses even a block the user had opened.
  useEffect(() => {
    if (!streaming) setExpanded(false);
  }, [streaming]);
  const preview = streaming && !expanded ? thinkingPreview(block.text) : null;
  return (
    <div
      className={`thinking-row thinking-${streaming ? "running" : "done"}`}
      data-testid={`thinking-${block.id}`}
      data-expanded={expanded ? "true" : "false"}
    >
      <button type="button" className="thinking-summary" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span className="row-chevron"><ChevronRight size={13} /></span>
        <span className={`row-bullet${streaming ? " animated" : ""}`} aria-hidden="true" />
        <strong>{header}</strong>
      </button>
      {expanded && <div className="thinking-body"><Markdown text={block.text} streaming={streaming} /></div>}
      {preview && preview.text !== "" && <ThinkingPreviewBody preview={preview} />}
    </div>
  );
}, (previous, next) => (
  previous.block.id === next.block.id
  && previous.block.text === next.block.text
  && previous.block.streaming === next.block.streaming
  && previous.block.elapsedMs === next.block.elapsedMs
));

/**
 * The running block's truncated tail: a muted `…` when lines were dropped, then the last lines the
 * TUI keeps. Plain text, not markdown — half-finished markdown would repaint on every chunk.
 */
function ThinkingPreviewBody({ preview }: { preview: ThinkingPreview }) {
  const textRef = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  // A long unbroken line wraps past the 3-line box; flag that so the `…` cue stays honest.
  useLayoutEffect(() => {
    const node = textRef.current;
    const clip = node?.parentElement;
    if (node && clip) setClipped(node.offsetHeight - clip.clientHeight > 1);
  }, [preview.text]);
  return (
    <div className="thinking-preview">
      {(preview.truncated || clipped) && <div className="thinking-ellipsis" aria-hidden="true">…</div>}
      <div className="thinking-preview-clip">
        <div className="thinking-preview-text" ref={textRef}>{preview.text}</div>
      </div>
    </div>
  );
}

export function ToolDetail({ tool }: { tool: ToolBlock }) {
  const [copied, setCopied] = useState<string | null>(null);
  const text = tool.content.map(contentText).filter(Boolean).join("\n");
  const images = tool.content.flatMap(contentImages);
  const pathText = tool.paths.map(displayPath).join("\n");
  const tallDiff = looksLikeDiff(text) && text.split("\n").length >= TALL_DIFF_LINES;
  const isEdit = EDIT_KINDS.includes((tool.kind ?? "").toLowerCase()) || tallDiff;

  async function copy(label: string, value: string) {
    if (!value) return;
    try {
      await copyText(value);
      setCopied(label);
      window.setTimeout(() => setCopied((current) => (current === label ? null : current)), 1200);
    } catch {
      setCopied("error");
    }
  }

  return (
    <div className="tool-detail">
      {(tool.command || pathText || text) && (
        <div className="tool-actions" aria-label="Tool actions">
          {tool.command && <button type="button" onClick={() => void copy("command", tool.command!)}><Copy size={12} /> {copied === "command" ? "Copied" : "Copy command"}</button>}
          {pathText && <button type="button" onClick={() => void copy("path", pathText)}><Clipboard size={12} /> {copied === "path" ? "Copied" : "Copy path"}</button>}
          {text && <button type="button" onClick={() => void copy("output", text)}><Files size={12} /> {copied === "output" ? "Copied" : "Copy output"}</button>}
          {tool.paths[0] && <button type="button" onClick={() => void openPath(displayPath(tool.paths[0])).catch(reportError)}><FolderOpen size={12} /> Open</button>}
          {isEdit && tallDiff && (
            <button
              type="button"
              data-testid="open-diff-preview"
              onClick={() => useArtifactStore.getState().openArtifact({
                kind: "diff",
                title: tool.paths[0] ? displayPath(tool.paths[0]) : tool.title,
                content: text,
              })}
            >
              <FileCode2 size={12} /> Open full diff
            </button>
          )}
        </div>
      )}
      {tool.command && <pre className="tool-command"><span className="shell-prefix">$ </span>{tool.command}</pre>}
      {text && !tallDiff && (
        <pre className={looksLikeDiff(text) ? "diff" : ""}>
          {text.split("\n").map((line, index) => (
            <span key={index} className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : ""}>{line}{"\n"}</span>
          ))}
        </pre>
      )}
      {tallDiff && <div className="utility-state">Diff is large — open it in Preview.</div>}
      {images.length > 0 && (
        <div className="tool-images">
          {images.map((src, index) => (
            <button
              key={`${src.slice(-20)}-${index}`}
              type="button"
              className="markdown-image-button"
              onClick={() => useArtifactStore.getState().openArtifact({ kind: "image", title: "Tool output", content: src })}
            >
              <img src={src} alt="Tool output" />
            </button>
          ))}
        </div>
      )}
      {tool.paths.length > 0 && <div className="tool-locations">{tool.paths.map((path) => <code key={path} title={displayPath(path)}>{displayPath(path)}</code>)}</div>}
    </div>
  );
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return value == null ? "" : String(value);
  const record = value as Record<string, unknown>;
  if (record.type === "diff" && typeof record.newText === "string") {
    const path = String(record.path ?? "file");
    const oldLines = typeof record.oldText === "string" ? record.oldText.split("\n").map((line) => `-${line}`) : [];
    const newLines = record.newText.split("\n").map((line) => `+${line}`);
    return [`--- ${path}`, `+++ ${path}`, ...oldLines, ...newLines].join("\n");
  }
  if (record.type === "text" && typeof record.text === "string") return record.text;
  if (typeof record.text === "string") return record.text;
  if (record.content && typeof record.content === "object") return contentText(record.content);
  if (typeof record.output === "string") return record.output;
  if (typeof record.diff === "string") return record.diff;
  return JSON.stringify(value, null, 2);
}

function contentImages(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (record.type === "image" && typeof record.data === "string") {
    return [`data:${String(record.mimeType ?? "image/png")};base64,${record.data}`];
  }
  if (record.content) return contentImages(record.content);
  return [];
}

function looksLikeDiff(text: string) {
  return text.includes("@@") || text.split("\n").some((line) => line.startsWith("+") || line.startsWith("-"));
}

function toolIcon(tool: ToolBlock) {
  const value = `${tool.kind ?? ""} ${tool.title}`.toLowerCase();
  if (/\b(execute|bash|shell|terminal|command|run)\b/.test(value)) return <Terminal size={14} />;
  if (/\b(search|grep|find|glob|rg)\b/.test(value)) return <Search size={14} />;
  if (/\b(read|cat|edit|write|file)\b/.test(value)) return <FileCode2 size={14} />;
  if (/\b(web|fetch|url|browser)\b/.test(value)) return <Globe2 size={14} />;
  return <Files size={14} />;
}

function normalizedStatus(status: string): string {
  const value = status.toLowerCase();
  if (["failed", "error"].includes(value)) return "failed";
  if (["cancelled", "canceled"].includes(value)) return "cancelled";
  if (isTerminalToolStatus(value)) return "completed";
  return "running";
}

function reportError(error: unknown) {
  const message = normalizeError(error, "The tool action failed");
  useSessionStore.getState().set({ error: message });
}
