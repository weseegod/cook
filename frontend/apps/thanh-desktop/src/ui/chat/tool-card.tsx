import { Check, ChevronRight, CircleEllipsis, Globe2, Search, Terminal, Wrench, X } from "lucide-react";
import type { ToolBlock } from "../../state/session";

export function ToolCard({ tool }: { tool: ToolBlock }) {
  const text = tool.content.map(contentText).filter(Boolean).join("\n");
  const images = tool.content.flatMap(contentImages);
  const icon = toolIcon(tool.kind ?? tool.title);
  return (
    <details className={`tool-card tool-${tool.status}`} open={tool.status === "failed"}>
      <summary>
        <span className="tool-chevron"><ChevronRight size={14} /></span>
        {icon}
        <strong>{tool.title}</strong>
        <span className="tool-status">{statusIcon(tool.status)} {tool.status}</span>
      </summary>
      {text && <pre className={looksLikeDiff(text) ? "diff" : ""}>{text.split("\n").map((line, index) => <span key={index} className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : ""}>{line}{"\n"}</span>)}</pre>}
      {images.length > 0 && <div className="tool-images">{images.map((src, index) => <img key={`${src.slice(-20)}-${index}`} src={src} alt="Tool output" />)}</div>}
      {tool.locations.length > 0 && <div className="tool-locations">{tool.locations.map((location, index) => <code key={index}>{contentText(location)}</code>)}</div>}
    </details>
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

function toolIcon(value: string) {
  const normalized = value.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("terminal")) return <Terminal size={15} />;
  if (normalized.includes("grep") || normalized.includes("search")) return <Search size={15} />;
  if (normalized.includes("web")) return <Globe2 size={15} />;
  return <Wrench size={15} />;
}

function statusIcon(status: string) {
  if (status === "completed") return <Check size={13} />;
  if (status === "failed") return <X size={13} />;
  return <CircleEllipsis size={13} />;
}
