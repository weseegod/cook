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
import { useState } from "react";
import { openPath } from "../../acp/host";
import { useSessionStore, type ToolBlock } from "../../state/session";
import { Markdown } from "./markdown";
import { copyText, displayPath } from "./clipboard";
import { formatThinkingDuration } from "./format-duration";
import { isLiveTool, isTerminalToolStatus } from "./transcript-projection";
import { verbGroupLabel } from "./verb-group";

/** Header text for a collapsed tool row (`scrollback/blocks/tool/*`). */
export function toolHeader(tool: ToolBlock): { prefix?: string; text: string } {
  if (tool.description) return { text: tool.description };
  if (isExecute(tool) && tool.command) return { prefix: "$ ", text: tool.command };
  const path = tool.paths[0] ? displayPath(tool.paths[0]) : null;
  const kind = (tool.kind ?? "").toLowerCase();
  if (path && isGenericTitle(tool.title, kind)) {
    if (["edit", "write", "write_file"].includes(kind)) return { text: `${kind === "write" || kind === "write_file" ? "Creating" : "Edit"} ${path}` };
    if (["list", "list_dir", "list_directory"].includes(kind)) return { text: `List ${path}` };
    if (["read", "file"].includes(kind)) return { text: `Read ${path}` };
  }
  return { text: tool.title };
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
export function VerbGroupRow({ tools }: { tools: ToolBlock[] }) {
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
}

/** One tool block, collapsed by default; no elapsed in the row and no rerun control. */
export function ToolRow({ tool }: { tool: ToolBlock }) {
  const header = toolHeader(tool);
  const running = isLiveTool(tool);
  return (
    <details className={`tool-row tool-${running ? "running" : normalizedStatus(tool.status)}`} data-testid={`tool-row-${tool.id}`}>
      <summary>
        <span className="row-chevron"><ChevronRight size={13} /></span>
        <span className={`row-bullet${running ? " animated" : ""}`} aria-hidden="true" />
        <span className="row-icon">{toolIcon(tool)}</span>
        <strong title={tool.title}>
          {header.prefix && <span className="row-prefix">{header.prefix}</span>}
          {header.text}
        </strong>
      </summary>
      <ToolDetail tool={tool} />
    </details>
  );
}

/** Thinking row: `Thinking…` while running, `Thought for 1.2s` once frozen. */
export function ThinkingRow({ block }: { block: { id: string; text: string; streaming: boolean; elapsedMs?: number | null } }) {
  const time = block.elapsedMs ?? null;
  const header = block.streaming ? "Thinking…" : time === null ? "Thought" : `Thought for ${formatThinkingDuration(time)}`;
  return (
    <details className="thinking-row" data-testid={`thinking-${block.id}`} open={block.streaming}>
      <summary>
        <span className="row-chevron"><ChevronRight size={13} /></span>
        <span className={`row-bullet${block.streaming ? " animated" : ""}`} aria-hidden="true" />
        <strong>{header}</strong>
      </summary>
      <div className="thinking-body"><Markdown text={block.text} streaming={block.streaming} /></div>
    </details>
  );
}

export function ToolDetail({ tool }: { tool: ToolBlock }) {
  const [copied, setCopied] = useState<string | null>(null);
  const text = tool.content.map(contentText).filter(Boolean).join("\n");
  const images = tool.content.flatMap(contentImages);
  const pathText = tool.paths.map(displayPath).join("\n");

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
        </div>
      )}
      {tool.command && <pre className="tool-command"><span className="shell-prefix">$ </span>{tool.command}</pre>}
      {text && (
        <pre className={looksLikeDiff(text) ? "diff" : ""}>
          {text.split("\n").map((line, index) => (
            <span key={index} className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : ""}>{line}{"\n"}</span>
          ))}
        </pre>
      )}
      {images.length > 0 && <div className="tool-images">{images.map((src, index) => <img key={`${src.slice(-20)}-${index}`} src={src} alt="Tool output" />)}</div>}
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
  const message = error instanceof Error ? error.message : String(error);
  useSessionStore.getState().set({ error: message });
}
