import type { MessageBlock, PlanBlock, ToolBlock, TranscriptBlock } from "../../state/session";

export interface ActivityBlock {
  type: "activity";
  id: string;
  turnId: string;
  tools: ToolBlock[];
  thoughts: MessageBlock[];
  status: "running" | "completed" | "failed";
}

export type DisplayBlock = MessageBlock | PlanBlock | ActivityBlock;

export function projectTranscript(blocks: TranscriptBlock[]): DisplayBlock[] {
  const projected: DisplayBlock[] = [];
  let activity: ActivityBlock | null = null;

  const flush = () => {
    if (!activity) return;
    activity.status = activityStatus(activity.tools, activity.thoughts);
    projected.push(activity);
    activity = null;
  };

  for (const block of blocks) {
    const isThought = block.type === "message" && block.role === "thought";
    if (block.type === "tool" || isThought) {
      if (!activity || activity.turnId !== block.turnId) {
        flush();
        activity = {
          type: "activity",
          id: `activity-${block.turnId}-${block.id}`,
          turnId: block.turnId,
          tools: [],
          thoughts: [],
          status: "completed",
        };
      }
      if (block.type === "tool") activity.tools.push(block);
      else activity.thoughts.push(block);
      continue;
    }
    flush();
    projected.push(block);
  }
  flush();
  return projected;
}

export function activityLabel(activity: ActivityBlock): string {
  if (activity.tools.length === 0) return activity.status === "running" ? "Thinking…" : "Thought";
  const categories = new Set(activity.tools.map(toolCategory));
  if (categories.size !== 1) {
    if (activity.status === "running") return `Running ${activity.tools.length} tools…`;
    return `${activity.tools.length} tool calls`;
  }

  const category = categories.values().next().value as ToolCategory;
  const count = activity.tools.length;
  const plural = count === 1 ? "" : "s";
  if (activity.status === "running") {
    return {
      read: "Reading files…",
      search: "Searching…",
      edit: "Editing files…",
      execute: "Running commands…",
      fetch: "Fetching pages…",
      mcp: "Using integrations…",
      other: "Running tool…",
    }[category];
  }
  return {
    read: `Read ${count} file${plural}`,
    search: `Searched ${count} source${plural}`,
    edit: `Edited ${count} file${plural}`,
    execute: `Ran ${count} command${plural}`,
    fetch: `Fetched ${count} page${plural}`,
    mcp: `Used ${count} integration${plural}`,
    other: count === 1 ? activity.tools[0].title : `${count} tool calls`,
  }[category];
}

type ToolCategory = "read" | "search" | "edit" | "execute" | "fetch" | "mcp" | "other";

export function toolCategory(tool: ToolBlock): ToolCategory {
  const value = `${tool.kind ?? ""} ${tool.title}`.toLowerCase();
  if (/\b(read|cat|open file|list dir|list files)\b/.test(value)) return "read";
  if (/\b(search|grep|find|glob|rg)\b/.test(value)) return "search";
  if (/\b(edit|write|patch|replace|create file)\b/.test(value)) return "edit";
  if (/\b(execute|bash|shell|terminal|command|run)\b/.test(value)) return "execute";
  if (/\b(web|fetch|url|browser)\b/.test(value)) return "fetch";
  if (/\b(mcp|integration|use_tool)\b/.test(value)) return "mcp";
  return "other";
}

function activityStatus(tools: ToolBlock[], thoughts: MessageBlock[]): ActivityBlock["status"] {
  if (tools.some((tool) => tool.status.toLowerCase() === "failed")) return "failed";
  if (
    thoughts.some((thought) => thought.streaming)
    || tools.some((tool) => !["completed", "failed"].includes(tool.status.toLowerCase()))
  ) return "running";
  return "completed";
}
