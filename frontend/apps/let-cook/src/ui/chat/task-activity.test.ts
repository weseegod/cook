import { describe, expect, it } from "vitest";
import { taskActivityLabel } from "./task-activity";

/**
 * The TUI's tasks-pane suffix (`app/subagent.rs::format_activity_label`), which differs from the
 * turn-status row's wording for the same `TurnActivity`.
 */
describe("taskActivityLabel", () => {
  it("names the streaming phases without the status row's ellipsis", () => {
    expect(taskActivityLabel({ kind: "thinking" })).toBe("Thinking");
    expect(taskActivityLabel({ kind: "responding" })).toBe("Responding");
    expect(taskActivityLabel({ kind: "compacting" })).toBe("Compacting");
  });

  it("says what a running tool is doing", () => {
    expect(taskActivityLabel({ kind: "tool", title: "execute", verb: "run", description: "Running cargo build" }))
      .toBe("Running cargo build\u2026");
    expect(taskActivityLabel({ kind: "tool", title: "execute", verb: "run", command: "cargo build" }))
      .toBe("Running: execute");
    expect(taskActivityLabel({ kind: "tool", title: "", verb: "run" })).toBe("Running tool");
  });

  it("clamps a long tool title the way the pane does", () => {
    const title = "a".repeat(60);
    expect(taskActivityLabel({ kind: "tool", title, verb: "run" })).toBe(`Running: ${"a".repeat(40)}\u2026`);
  });

  it("keeps only the first line of a multi-line title", () => {
    expect(taskActivityLabel({ kind: "tool", title: "cargo build\ncargo test", verb: "run" })).toBe("Running: cargo build");
  });

  it("words waits, and says nothing for an update that carries no phase", () => {
    expect(taskActivityLabel({ kind: "waiting", reason: { kind: "subagent", display: "Explore" } })).toBe("Explore\u2026");
    expect(taskActivityLabel({ kind: "waiting", reason: { kind: "tasks-complete" } })).toBe("Waiting on tasks\u2026");
    expect(taskActivityLabel({ kind: "waiting", reason: { kind: "task-output", subject: "Wait 5 seconds" } }))
      .toBe("Wait 5 seconds\u2026");
    expect(taskActivityLabel(null)).toBeUndefined();
  });
});
