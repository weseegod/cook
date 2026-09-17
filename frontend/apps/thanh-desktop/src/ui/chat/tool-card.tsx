import { Check, ChevronRight, CircleEllipsis, Files, Globe2, Search, Terminal, Wrench, X } from "lucide-react";
import type { ToolBlock } from "../../state/session";
import { Markdown } from "./markdown";
import { activityLabel, toolCategory, type ActivityBlock } from "./transcript-projection";

export function ActivityGroup({ activity }: { activity: ActivityBlock }) {
  const open = activity.status === "failed";
  return (
    <details className={`activity-group activity-${activity.status}`} open={open}>
      <summary>
        <span className="activity-chevron"><ChevronRight size={13} /></span>
        <span className="activity-state">{statusIcon(activity.status)}</span>
        <strong>{activityLabel(activity)}</strong>
        <span className="activity-meta">{activity.tools.length > 0 ? `${activity.tools.length} ${activity.tools.length === 1 ? "tool" : "tools"}` : "reasoning"}</span>
      </summary>
      <div className="activity-details">
        {activity.thoughts.map((thought) => (
          <div className="activity-thought" key={thought.id}>
            <span>Reasoning</span>
            <Markdown text={thought.text} streaming={thought.streaming} />
          </div>
        ))}
        {activity.tools.map((tool) => <ToolDetail key={tool.id} tool={tool} />)}
      </div>
    </details>
  );
}

function ToolDetail({ tool }: { tool: ToolBlock }) {
  const text = tool.content.map(contentText).filter(Boolean).join("\n");
  const images = tool.content.flatMap(contentImages);
  return (
    <section className={`tool-detail tool-${tool.status}`}>
      <header>
        {toolIcon(tool)}
        <strong title={tool.title}>{tool.title}</strong>
        <span>{statusIcon(normalizedStatus(tool.status))} {tool.status.replaceAll("_", " ")}</span>
      </header>
      {text && (
        <pre className={looksLikeDiff(text) ? "diff" : ""}>
          {text.split("\n").map((line, index) => (
            <span key={index} className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : ""}>{line}{"\n"}</span>
          ))}
        </pre>
      )}
      {images.length > 0 && <div className="tool-images">{images.map((src, index) => <img key={`${src.slice(-20)}-${index}`} src={src} alt="Tool output" />)}</div>}
      {tool.locations.length > 0 && <div className="tool-locations">{tool.locations.map((location, index) => <code key={index}>{contentText(location)}</code>)}</div>}
    </section>
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

function toolIcon(tool: ToolBlock) {
  const category = toolCategory(tool);
  if (category === "execute") return <Terminal size={14} />;
  if (category === "search") return <Search size={14} />;
  if (category === "read" || category === "edit") return <Files size={14} />;
  if (category === "fetch") return <Globe2 size={14} />;
  return <Wrench size={14} />;
}

function normalizedStatus(status: string): ActivityBlock["status"] {
  if (status.toLowerCase() === "failed") return "failed";
  if (status.toLowerCase() === "completed") return "completed";
  return "running";
}

function statusIcon(status: ActivityBlock["status"]) {
  if (status === "completed") return <Check size={13} />;
  if (status === "failed") return <X size={13} />;
  return <CircleEllipsis className="spin" size={13} />;
}
