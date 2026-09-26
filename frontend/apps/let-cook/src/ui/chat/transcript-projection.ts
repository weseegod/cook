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

export function projectTranscript(blocks: readonly TranscriptBlock[]): DisplayBlock[] {
  const output: DisplayBlock[] = [];
  let run: { tools: ToolBlock[]; thoughts: MessageBlock[] } | null = null;

  const flush = () => {
    if (!run) return;
    const current = run;
    run = null;
    if (current.tools.length > 0) {
      output.push({ type: "verb-group", id: `verb-${current.tools[0].id}`, tools: current.tools });
      return;
    }
    if (current.thoughts.length > 1) {
      output.push({ type: "thought-group", id: `thought-${current.thoughts[0].id}`, thoughts: current.thoughts });
      return;
    }
    for (const thought of current.thoughts) output.push(thought);
  };

  for (const block of blocks) {
    if (block.type === "plan") continue;
    if (block.type === "tool") {
      if (verbKind(block)) {
        run ??= { tools: [], thoughts: [] };
        run.tools.push(block);
        continue;
      }
      flush();
      output.push({ type: "tool", id: block.id, tool: block });
      continue;
    }
    if (block.type === "message" && block.role === "thought") {
      // Finished thoughts are claimed into an open run (height 0, never labeled) and can anchor one.
      // A still-streaming thought is transparent: it keeps its own row and breaks the run.
      if (block.streaming) {
        flush();
        output.push(block);
        continue;
      }
      run ??= { tools: [], thoughts: [] };
      run.thoughts.push(block);
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
