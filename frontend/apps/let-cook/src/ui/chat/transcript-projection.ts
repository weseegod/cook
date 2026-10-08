import type { MessageBlock, SessionEventBlock, ToolBlock, TranscriptBlock } from "../../state/session";
import { verbKind } from "./verb-group";

/**
 * Transcript rows as the TUI paints them (`scrollback/` blocks). Verb groups stand in for
 * consecutive foldable tools; thought groups compact consecutive finished thinking blocks.
 * ACP `Plan` blocks stay in session state for GoalDetail / the todo overlay — they are not
 * scrollback rows (catalog §9.8).
 */
export type DisplayBlock =
  | MessageBlock
  | SessionEventBlock
  | { type: "tool"; id: string; tool: ToolBlock }
  | { type: "verb-group"; id: string; tools: ToolBlock[] }
  | { type: "thought-group"; id: string; thoughts: MessageBlock[] };

/** One entry inside an open verb run, in arrival order. */
type RunEntry =
  | { entry: "tool"; tool: ToolBlock }
  | { entry: "thought"; thought: MessageBlock };

export function projectTranscript(blocks: readonly TranscriptBlock[]): DisplayBlock[] {
  const output: DisplayBlock[] = [];
  let run: { entries: RunEntry[] } | null = null;

  const flush = () => {
    if (!run) return;
    const entries = run.entries;
    run = null;
    const tools = entries.flatMap((item) => (item.entry === "tool" ? [item.tool] : []));
    const group: DisplayBlock | null = tools.length > 0
      ? { type: "verb-group", id: `verb-${tools[0].id}`, tools }
      : null;
    // Walk in arrival order so a live `Thinking…` row sits where it began. Finished thoughts are
    // claimed into the group beside the tools and never paint a row of their own; with no tools
    // they compact into one group, or one row when they are alone.
    const thoughtRun: MessageBlock[] = [];
    const liveRun: MessageBlock[] = [];
    const emitGroup = () => {
      // A live `Thinking…` row is Transparent: it keeps its own row rather than moving under the
      // group header (`verb_group.rs::RunStep::Transparent`).
      for (const thought of liveRun) output.push(thought);
      if (group) {
        output.push(group);
        return;
      }
      if (thoughtRun.length > 1) output.push({ type: "thought-group", id: `thought-${thoughtRun[0].id}`, thoughts: [...thoughtRun] });
      else if (thoughtRun.length === 1) output.push(thoughtRun[0]);
    };
    for (const item of entries) {
      if (item.entry === "tool") continue;
      if (item.thought.streaming) liveRun.push(item.thought);
      else thoughtRun.push(item.thought);
    }
    emitGroup();
  };

  for (const block of blocks) {
    if (block.type === "plan") continue;
    if (block.type === "tool") {
      if (verbKind(block)) {
        run ??= { entries: [] };
        run.entries.push({ entry: "tool", tool: block });
        continue;
      }
      flush();
      output.push({ type: "tool", id: block.id, tool: block });
      continue;
    }
    if (block.type === "message" && block.role === "thought") {
      // A still-streaming thought paints its own live row outside the group but never splits the
      // run around it (`verb_group.rs::RunStep::Transparent`). A finished thought folds in at
      // height 0 and is never labeled on the header (`RunStep::ThoughtMember`).
      run ??= { entries: [] };
      run.entries.push({ entry: "thought", thought: block });
      continue;
    }
    flush();
    output.push(block);
  }
  flush();
  return output;
}

export function isTerminalToolStatus(status: string): boolean {
  return ["completed", "complete", "failed", "error", "cancelled", "canceled"].includes(status.toLowerCase());
}

export function isLiveTool(tool: ToolBlock): boolean {
  return !isTerminalToolStatus(tool.status);
}
