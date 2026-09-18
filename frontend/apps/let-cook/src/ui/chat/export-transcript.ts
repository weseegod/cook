/**
 * Pure transcript → Markdown export (`/export`).
 *
 * User and assistant message text only by default — tool dumps, thoughts, plans, and
 * session-event chrome are omitted so the file stays useful for "continue elsewhere".
 */
import type { TranscriptBlock } from "../../state/session";

export interface ExportTranscriptOptions {
  /** Include a compact `## Tools` section (TUI-style). Default: false. */
  includeTools?: boolean;
}

/** Render transcript blocks as Markdown. Empty input yields `""`. */
export function exportTranscriptMarkdown(
  blocks: readonly TranscriptBlock[],
  options: ExportTranscriptOptions = {},
): string {
  const includeTools = options.includeTools === true;
  let out = "";
  let lastWasAssistant = false;
  let inToolsSection = false;

  for (const block of blocks) {
    if (block.type === "message" && block.role === "user") {
      if (inToolsSection) {
        out += "\n";
        inToolsSection = false;
      }
      out += `## User\n\n${block.text}\n\n`;
      lastWasAssistant = false;
      continue;
    }
    if (block.type === "message" && block.role === "assistant") {
      if (!lastWasAssistant) {
        if (inToolsSection) {
          out += "\n";
          inToolsSection = false;
        }
        out += "## Assistant\n\n";
      }
      out += `${block.text}\n\n`;
      lastWasAssistant = true;
      continue;
    }
    if (includeTools && block.type === "tool") {
      if (!inToolsSection) {
        out += "## Tools\n\n";
        inToolsSection = true;
      }
      out += `- ${toolSummary(block)}\n`;
      lastWasAssistant = false;
      continue;
    }
    // Skip thoughts, plans, session-events, and tools (unless opted in).
  }

  return out.trimEnd();
}

function toolSummary(tool: { title: string; kind?: string; command?: string; paths: string[] }): string {
  if (tool.command) return `Execute: ${tool.command}`;
  if (tool.paths.length > 0) return `${tool.title || tool.kind || "Tool"}: ${tool.paths.join(", ")}`;
  return tool.title || tool.kind || "Tool";
}

/** Trigger a browser download of a Markdown file. */
export function downloadMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.endsWith(".md") ? filename : `${filename}.md`;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Safe filename from a session title (or a fallback). */
export function exportFilename(title?: string | null, sessionId?: string | null): string {
  const base = (title?.trim() || sessionId || "conversation")
    .replace(/[^\w\s.-]+/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80)
    .replace(/^-+|-+$/g, "")
    || "conversation";
  return `${base}.md`;
}
