import {
  CheckCircle2,
  ChevronRight,
  CircleEllipsis,
  Clipboard,
  Copy,
  FileCode2,
  Files,
  FolderOpen,
  Globe2,
  Play,
  Search,
  Terminal,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { acpClient } from "../../acp/client";
import { openPath } from "../../acp/host";
import { useSessionStore, type ToolBlock } from "../../state/session";
import { Markdown } from "./markdown";
import { copyText, displayPath } from "./clipboard";
import {
  activityElapsedMs,
  activityLabel,
  isLiveTool,
  toolCategory,
  type ActivityBlock,
  type ActivityStatus,
} from "./transcript-projection";

export function ActivityGroup({ activity }: { activity: ActivityBlock }) {
  const [now, setNow] = useState(Date.now());
  const open = activity.status === "failed" || activity.status === "running";

  useEffect(() => {
    if (activity.status !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activity.status]);

  return (
    <details className={`activity-group activity-${activity.status}`} open={open}>
      <summary>
        <span className="activity-chevron"><ChevronRight size={13} /></span>
        <span className="activity-state">{statusIcon(activity.status)}</span>
        <strong>{activityLabel(activity)}</strong>
        <span className="activity-meta">
          {formatElapsed(activityElapsedMs(activity, now))}
          {activity.tools.length > 0 && ` · ${activity.tools.length} ${activity.tools.length === 1 ? "tool" : "tools"}`}
        </span>
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

export function LiveActivityRail({ activities, turnElapsedMs, onCancel }: {
  activities: ActivityBlock[];
  turnElapsedMs: number | null;
  onCancel: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (activities.length === 0 && turnElapsedMs === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activities.length, turnElapsedMs]);
  if (activities.length === 0 && turnElapsedMs === null) return null;

  return (
    <section className="live-activity-rail" aria-label="Live activity" data-testid="live-activity-rail">
      <div className="live-activity-heading">
        <span><CircleEllipsis className="spin" size={13} /> Working</span>
        <span className="live-activity-turn-time">{formatElapsed(turnElapsedMs ?? 0, now)}</span>
        <button type="button" className="text-button danger-text" onClick={onCancel}>Cancel</button>
      </div>
      <div className="live-activity-items">
        {activities.flatMap((activity) => activity.tools.filter(isLiveTool).map((tool) => (
          <LiveToolRow key={tool.id} tool={tool} now={now} />
        )))}
      </div>
    </section>
  );
}

function LiveToolRow({ tool, now }: { tool: ToolBlock; now: number }) {
  return (
    <div className="live-activity-row">
      <span className="activity-state">{statusIcon("running")}</span>
      <span className="live-tool-icon">{toolIcon(tool)}</span>
      <strong title={tool.command ?? tool.title}>{tool.description || tool.command || tool.title}</strong>
      <code>{formatElapsed(tool.elapsedMs ?? Math.max(0, now - tool.startedAt), now)}</code>
    </div>
  );
}

function ToolDetail({ tool }: { tool: ToolBlock }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const text = tool.content.map(contentText).filter(Boolean).join("\n");
  const images = tool.content.flatMap(contentImages);
  const pathText = tool.paths.map(displayPath).join("\n");

  async function copy(label: string, value: string) {
    if (!value) return;
    try {
      await copyText(value);
      setCopied(label);
      window.setTimeout(() => setCopied((current) => current === label ? null : current), 1200);
    } catch {
      setCopied("error");
    }
  }

  async function execute() {
    if (!tool.command || busy) return;
    setBusy(true);
    try {
      await acpClient.rerunCommand(tool.command);
    } catch (error) {
      useError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`tool-detail tool-${tool.status}`} data-testid={`tool-detail-${tool.id}`}>
      <header>
        {toolIcon(tool)}
        <strong title={tool.title}>{tool.description || tool.title}</strong>
        <span className="tool-status">{statusIcon(normalizedStatus(tool.status))} {tool.status.replaceAll("_", " ")}</span>
        <span className="tool-elapsed">{formatElapsed(tool.elapsedMs ?? Math.max(0, Date.now() - tool.startedAt))}</span>
      </header>
      {(tool.command || pathText || text) && (
        <div className="tool-actions" aria-label="Tool actions">
          {tool.command && <button type="button" onClick={() => void copy("command", tool.command!)}><Copy size={12} /> {copied === "command" ? "Copied" : "Copy command"}</button>}
          {pathText && <button type="button" onClick={() => void copy("path", pathText)}><Clipboard size={12} /> {copied === "path" ? "Copied" : "Copy path"}</button>}
          {tool.command && <button type="button" onClick={() => void execute()} disabled={busy || isLiveTool(tool)}><Play size={12} /> {busy ? "Running…" : "Execute"}</button>}
          {text && <button type="button" onClick={() => void copy("output", text)}><Files size={12} /> {copied === "output" ? "Copied" : "Copy output"}</button>}
          {tool.paths[0] && <button type="button" onClick={() => void openPath(displayPath(tool.paths[0])).catch(useError)}><FolderOpen size={12} /> Open</button>}
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
  const category = toolCategory(tool);
  if (category === "execute") return <Terminal size={14} />;
  if (category === "search") return <Search size={14} />;
  if (category === "read" || category === "edit") return <FileCode2 size={14} />;
  if (category === "fetch") return <Globe2 size={14} />;
  return <Files size={14} />;
}

function normalizedStatus(status: string): ActivityStatus {
  if (["failed", "error"].includes(status.toLowerCase())) return "failed";
  if (["cancelled", "canceled"].includes(status.toLowerCase())) return "cancelled";
  if (["completed", "complete"].includes(status.toLowerCase())) return "completed";
  return "running";
}

function statusIcon(status: ActivityStatus) {
  if (status === "completed") return <CheckCircle2 size={13} />;
  if (status === "failed") return <XCircle size={13} />;
  if (status === "cancelled") return <X size={13} />;
  return <CircleEllipsis className="spin" size={13} />;
}

function formatElapsed(milliseconds: number, now?: number): string {
  const value = Math.max(0, now === undefined ? milliseconds : milliseconds);
  if (value < 1000) return "0.0s";
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.floor(seconds % 60)}s`;
}

function useError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  useSessionStore.getState().set({ error: message });
}
