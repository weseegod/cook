import { state } from "../state";
import type { MethodHandler } from "./registry";

/**
 * `x.ai/prompts/*` over the mock store: defaults come from `state.promptDefaults`, user copies from
 * `state.promptFiles`, so a test can seed an edited copy or assert a reset wrote the default back.
 */
function relativeOf(p: Record<string, unknown>): string {
  return String(p.relative ?? "");
}

function stateOf(relative: string): "absent" | "unmodified" | "modified" {
  const copy = state.promptFiles[relative];
  if (copy === undefined) return "absent";
  return copy.replace(/\n$/, "") === (state.promptDefaults[relative] ?? "").replace(/\n$/, "")
    ? "unmodified"
    : "modified";
}

export const promptHandlers: Record<string, MethodHandler> = {
  "x.ai/prompts/list": ({ respond }) => {
    const prompts = Object.keys(state.promptDefaults)
      .sort()
      .map((relative) => ({
        relative,
        path: `${state.promptRoot}/${relative}`,
        state: stateOf(relative),
      }));
    return respond({ result: { root: state.promptRoot, prompts } });
  },
  "x.ai/prompts/read": ({ p, respond }) => {
    const relative = relativeOf(p);
    if (!(relative in state.promptDefaults)) return respond({ error: `unknown prompt: ${relative}` });
    return respond({
      result: {
        relative,
        path: `${state.promptRoot}/${relative}`,
        state: stateOf(relative),
        content: state.promptFiles[relative] ?? null,
        default: state.promptDefaults[relative] ?? "",
      },
    });
  },
  "x.ai/prompts/write": ({ p, respond }) => {
    const relative = relativeOf(p);
    if (!(relative in state.promptDefaults)) return respond({ error: `unknown prompt: ${relative}` });
    state.promptFiles[relative] = String(p.content ?? "");
    return respond({ result: { relative, state: stateOf(relative) } });
  },
  "x.ai/prompts/restore": ({ p, respond }) => {
    const relative = relativeOf(p);
    if (!(relative in state.promptDefaults)) return respond({ error: `unknown prompt: ${relative}` });
    // The shell writes the compiled default back, byte for byte, leaving an unmodified copy.
    state.promptFiles[relative] = state.promptDefaults[relative] ?? "";
    return respond({ result: { relative, state: stateOf(relative) } });
  },
};
