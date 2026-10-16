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
    // A run of nothing but one shell command folds to the less useful `Ran 1 command`, so it keeps
    // the `$ <command>` row (`RunScan::folds`).
    const folds = tools.length > 0 && !(tools.length === 1 && verbKind(tools[0]) === "command");
    // The run's row stands where its first member is: the folded header, or a lone command's `$` row.
    const runRow: DisplayBlock | null = tools.length === 0
      ? null
      : folds
        ? { type: "verb-group", id: `verb-${tools[0].id}`, tools }
        : { type: "tool", id: tools[0].id, tool: tools[0] };
    const finished = entries.flatMap((item) => (item.entry === "thought" && !item.thought.streaming ? [item.thought] : []));
    let emittedRunRow = false;
    let emittedFinished = false;
    // Wire order is paint order: a live `Thinking…` row is Transparent, so it keeps its own row at
    // its own index while the folded members collapse to height 0 (`verb_group.rs::RunStep`).
    for (const item of entries) {
      if (item.entry === "tool") {
        if (!emittedRunRow && runRow) {
          output.push(runRow);
          emittedRunRow = true;
        }
        continue;
      }
      if (item.thought.streaming) {
        output.push(item.thought);
        continue;
      }
      // A folding run claims its finished thoughts at height 0, so they never paint a row.
      if (folds || emittedFinished) continue;
      // Without a fold the finished thoughts compact into one group, or one row when they are alone.
      emittedFinished = true;
      output.push(finished.length > 1
        ? { type: "thought-group", id: `thought-${finished[0].id}`, thoughts: [...finished] }
        : item.thought);
    }
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
