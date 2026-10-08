import { state } from "../state";
import type { MethodHandler } from "./registry";

/**
 * `x.ai/skills/default` and `x.ai/skills/restore` over the mock store: shipped bodies come from
 * `state.skillDefaults`, user copies from `state.skillFiles`, so a test can seed an edited copy or
 * assert a reset wrote the shipped body back.
 *
 * A name outside `state.skillDefaults` answers `hasDefault: false`, the way the shell answers for a
 * skill the user wrote, so the viewer hides Reset instead of treating it as an error.
 */
function nameOf(p: Record<string, unknown>): string {
  return String(p.name ?? "");
}

function skillPath(name: string): string {
  return `${state.skillsRoot}/${name}/SKILL.md`;
}

function stateOf(name: string): "absent" | "unmodified" | "modified" {
  const copy = state.skillFiles[name];
  if (copy === undefined) return "absent";
  return copy.replace(/\n$/, "") === (state.skillDefaults[name] ?? "").replace(/\n$/, "")
    ? "unmodified"
    : "modified";
}

export const skillDefaultHandlers: Record<string, MethodHandler> = {
  "x.ai/skills/default": ({ p, respond }) => {
    const name = nameOf(p);
    if (!(name in state.skillDefaults)) {
      return respond({
        result: { name, path: "", hasDefault: false, state: "absent", content: null, default: "" },
      });
    }
    return respond({
      result: {
        name,
        path: skillPath(name),
        hasDefault: true,
        state: stateOf(name),
        content: state.skillFiles[name] ?? null,
        default: state.skillDefaults[name] ?? "",
      },
    });
  },
  "x.ai/skills/restore": ({ p, respond }) => {
    const name = nameOf(p);
    if (!(name in state.skillDefaults)) return respond({ error: `${name} has no shipped default` });
    if (state.skillFiles[name] === undefined) {
      return respond({ error: `no user copy of ${name} to reset` });
    }
    // The shell writes the shipped body back, byte for byte, leaving an unmodified copy.
    state.skillFiles[name] = state.skillDefaults[name] ?? "";
    return respond({ result: { name, state: stateOf(name) } });
  },
};
