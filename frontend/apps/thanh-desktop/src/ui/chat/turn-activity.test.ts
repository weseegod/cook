import { describe, expect, it } from "vitest";
import {
  activityParts,
  activityText,
  clampActivitySubject,
  formatWaitingForSubject,
  isPhaseTransition,
  isSendableWait,
  MAX_ACTIVITY_SUBJECT_CHARS,
  phaseKey,
  writingToolCallLabel,
  type TurnActivity,
} from "./turn-activity";

describe("activity labels (TUI turn_status / tracker strings)", () => {
  const cases: Array<[TurnActivity, string]> = [
    [{ kind: "cancelling" }, "Cancelling…"],
    [{ kind: "verifying" }, "Verifying…"],
    [{ kind: "thinking" }, "Thinking…"],
    [{ kind: "responding" }, "Responding…"],
    [{ kind: "compacting" }, "Compacting…"],
    [{ kind: "bash" }, "Running…"],
    [{ kind: "unknown" }, "Waiting…"],
    [{ kind: "starting-session" }, "Starting session…"],
    [{ kind: "retrying", attempt: 2 }, "Retrying (attempt 2)..."],
    [{ kind: "waiting", reason: { kind: "model" } }, "Waiting for response…"],
    [{ kind: "waiting", reason: { kind: "prompt-ack" } }, "Waiting for the agent to accept the prompt…"],
    [{ kind: "waiting", reason: { kind: "subagent" } }, "Waiting on subagent…"],
    [{ kind: "waiting", reason: { kind: "subagent", display: "Inspect the parser" } }, "Inspect the parser…"],
    [{ kind: "waiting", reason: { kind: "task-output" } }, "Waiting on task output…"],
    [{ kind: "waiting", reason: { kind: "task-output", subject: "Wait 5 seconds" } }, "Wait 5 seconds…"],
    [{ kind: "waiting", reason: { kind: "tasks-complete" } }, "Waiting on tasks…"],
    [{ kind: "waiting", reason: { kind: "sleep" } }, "Sleeping…"],
    [{ kind: "waiting", reason: { kind: "hooks", event: "pre_tool", count: 1 } }, "Running pre_tool hook…"],
    [{ kind: "waiting", reason: { kind: "hooks", event: "pre_tool", count: 3 } }, "Running 3 pre_tool hooks…"],
    [{ kind: "ask", detail: "Which storage?" }, "Waiting on answers for Which storage?"],
    [{ kind: "command", displayName: "/compact" }, "/compact…"],
  ];

  it.each(cases)("%o → %s", (activity, expected) => {
    expect(activityText(activity)).toBe(expected);
  });

  it("splits tool verbs from their subject", () => {
    expect(activityParts({ kind: "tool", title: "bash", verb: "run", command: "pnpm test" }))
      .toEqual({ prefix: "Run ", subject: "pnpm test", text: "Run pnpm test" });
    expect(activityParts({ kind: "tool", title: "web_search", verb: "search", query: "tauri ipc" }))
      .toEqual({ prefix: "Search ", subject: "tauri ipc", text: "Search tauri ipc" });
    expect(activityParts({ kind: "tool", title: "web_fetch", verb: "fetch", url: "https://example.com" }))
      .toEqual({ prefix: "Fetch ", subject: "https://example.com", text: "Fetch https://example.com" });
  });

  it("prefers a tool description over the raw command", () => {
    expect(activityText({ kind: "tool", title: "bash", verb: "run", command: "pnpm test", description: "Run the unit suite" }))
      .toBe("Run the unit suite…");
  });
});

describe("subject clamping", () => {
  it("takes the first non-empty line and clamps to 40 chars", () => {
    expect(clampActivitySubject("  \n  hello world  \nignored")).toBe("hello world");
    const long = "x".repeat(60);
    expect(clampActivitySubject(long)).toHaveLength(MAX_ACTIVITY_SUBJECT_CHARS);
    expect(formatWaitingForSubject(long)).toBe(`${"x".repeat(40)}…`);
    expect(formatWaitingForSubject("   ")).toBe("Waiting on task output…");
  });
});

describe("phase transitions", () => {
  it("resets on a new tool title but not on description churn", () => {
    const first: TurnActivity = { kind: "tool", title: "bash", verb: "run", command: "a", description: "one" };
    const churn: TurnActivity = { kind: "tool", title: "bash", verb: "run", command: "a", description: "two" };
    const next: TurnActivity = { kind: "tool", title: "read", verb: "run" };
    expect(isPhaseTransition(first, churn)).toBe(false);
    expect(isPhaseTransition(churn, next)).toBe(true);
    expect(phaseKey(first)).toBe("tool:bash");
  });

  it("restarts on each retry attempt", () => {
    expect(phaseKey({ kind: "retrying", attempt: 1 })).not.toBe(phaseKey({ kind: "retrying", attempt: 2 }));
  });
});

describe("sendable waits", () => {
  it("only sendable reasons advertise the queued hint", () => {
    expect(isSendableWait({ kind: "waiting", reason: { kind: "sleep" } })).toBe(true);
    expect(isSendableWait({ kind: "waiting", reason: { kind: "tasks-complete" } })).toBe(true);
    expect(isSendableWait({ kind: "waiting", reason: { kind: "model" } })).toBe(false);
    expect(isSendableWait({ kind: "thinking" })).toBe(false);
  });
});

describe("activity priority", () => {
  it("uses the first pending tool when several calls are live", async () => {
    const { deriveActivity } = await import("./turn-activity");
    expect(deriveActivity([
      { type: "tool", title: "Read a.ts", status: "pending" },
      { type: "tool", title: "Read b.ts", status: "pending" },
    ])).toMatchObject({ kind: "tool", title: "Read a.ts" });
  });

  it("keeps thinking above pending tools during an out-of-order replay batch", async () => {
    const { deriveActivity } = await import("./turn-activity");
    expect(deriveActivity([
      { type: "message", role: "thought", streaming: true },
      { type: "tool", title: "Read a.ts", status: "pending" },
    ])).toEqual({ kind: "thinking" });
  });
});

describe("writing tool call labels", () => {
  it("matches the tracker vocabulary", () => {
    expect(writingToolCallLabel("task")).toBe("Writing subagent prompt…");
    expect(writingToolCallLabel("use_tool", 2)).toBe("Preparing MCP tool (2)…");
    expect(writingToolCallLabel("search_tool")).toBe("Searching MCP tools…");
    expect(writingToolCallLabel("write")).toBe("Writing file…");
    expect(writingToolCallLabel("edit")).toBe("Writing edit…");
    expect(writingToolCallLabel("execute")).toBe("Writing command…");
    expect(writingToolCallLabel("plan")).toBe("Updating todo list…");
    expect(writingToolCallLabel("workflow")).toBe("Writing workflow…");
    expect(writingToolCallLabel("ask_user_question")).toBe("Preparing question…");
    expect(writingToolCallLabel(undefined)).toBe("Preparing tool call…");
    expect(writingToolCallLabel("custom_thing")).toBe("Preparing custom_thing…");
  });
});
