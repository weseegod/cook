import { describe, expect, it, vi } from "vitest";
import type { CommandSummary, ModelSummary, SessionInfo } from "../../acp/xai";
import {
  clientCommand,
  matchSlashCommands,
  parseSlash,
  slashEntries,
  type SlashCommandContext,
  type SlashCommandHost,
} from "./slash-commands";

const MODELS: ModelSummary[] = [
  { id: "grok-4.6", name: "Grok 4.6", provider: "xai" },
  { id: "deepseek/deepseek-flash", name: "DeepSeek Flash", provider: "deepseek" },
  { id: "zai/glm-5.3-flash", name: "GLM 5.3 Flash", provider: "zai" },
];

function host(info: SessionInfo | null = null): SlashCommandHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    setPlanMode: vi.fn(async (enabled: boolean) => void calls.push(`plan:${enabled}`)),
    setModel: vi.fn(async (modelId: string) => void calls.push(`model:${modelId}`)),
    setYolo: vi.fn(async (enabled: boolean) => void calls.push(`yolo:${enabled}`)),
    newSession: vi.fn(async () => void calls.push("new")),
    sendPrompt: vi.fn(async (text: string) => void calls.push(`prompt:${text}`)),
    sessionInfo: vi.fn(async () => info),
  };
}

function context(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    sessionId: "s1",
    modelId: "grok-4.6",
    planMode: false,
    alwaysApprove: false,
    usage: null,
    models: MODELS,
    ...overrides,
  };
}

describe("parseSlash", () => {
  it("splits a leading name from its arguments", () => {
    expect(parseSlash("/plan")).toEqual({ name: "plan", args: "" });
    expect(parseSlash("/goal  ship the release ")).toEqual({ name: "goal", args: "ship the release" });
    expect(parseSlash("  /model grok-4.6")).toEqual({ name: "model", args: "grok-4.6" });
  });

  it("lower-cases the name and keeps the arguments' case", () => {
    expect(parseSlash("/Plan Refactor Auth")).toEqual({ name: "plan", args: "Refactor Auth" });
  });

  it("ignores text that is not a command and names that could be a path", () => {
    expect(parseSlash("explain /plan")).toBeNull();
    expect(parseSlash("/")).toBeNull();
    expect(parseSlash("/src/main.rs")).toBeNull();
  });
});

describe("slashEntries", () => {
  const agent: CommandSummary[] = [
    { name: "goal", description: "Set a goal" },
    { name: "compact", description: "Compress history" },
  ];

  it("offers the window's own commands before the agent's", () => {
    const entries = slashEntries(agent);
    expect(entries.slice(0, 3).map((entry) => [entry.name, entry.source])).toEqual([
      ["plan", "client"],
      ["model", "client"],
      ["new", "client"],
    ]);
    expect(entries.map((entry) => entry.name)).toContain("goal");
  });

  it("lets the window win a name the agent also advertises", () => {
    const entries = slashEntries([...agent, { name: "plan", description: "Agent plan" }]);
    expect(entries.filter((entry) => entry.name === "plan")).toEqual([
      expect.objectContaining({ source: "client" }),
    ]);
  });
});

describe("matchSlashCommands", () => {
  it("ranks prefix matches above names that merely contain the query", () => {
    const names = matchSlashCommands(slashEntries([{ name: "view-plan" }]), "pl")
      .map((entry) => entry.name);
    expect(names).toEqual(["plan", "view-plan"]);
  });

  it("returns everything for an empty query and caps the list", () => {
    const entries = slashEntries([{ name: "goal" }]);
    expect(matchSlashCommands(entries, "").length).toBe(entries.length);
    expect(matchSlashCommands(entries, "", 2)).toHaveLength(2);
  });
});

describe("/plan", () => {
  it("enters plan mode and explains itself when no description is given", async () => {
    const h = host();
    const message = await clientCommand("plan")!.run(h, context(), "");
    expect(h.calls).toEqual(["plan:true"]);
    expect(message).toContain("Plan mode is on");
  });

  it("sends the description as the first turn when one is given", async () => {
    const h = host();
    const message = await clientCommand("plan")!.run(h, context(), "add auth");
    expect(h.calls).toEqual(["plan:true", "prompt:add auth"]);
    expect(message).toBeNull();
  });

  it("changes nothing when plan mode is already on", async () => {
    const h = host();
    const message = await clientCommand("plan")!.run(h, context({ planMode: true }), "");
    expect(h.calls).toEqual([]);
    expect(message).toContain("Already in plan mode");
  });
});

describe("/model", () => {
  it("lists the catalog when no model is named", async () => {
    const h = host();
    const message = await clientCommand("model")!.run(h, context(), "");
    expect(h.calls).toEqual([]);
    expect(message).toContain("deepseek/deepseek-flash");
  });

  it("switches on an exact id", async () => {
    const h = host();
    const message = await clientCommand("model")!.run(h, context(), "grok-4.6");
    expect(h.calls).toEqual(["model:grok-4.6"]);
    expect(message).toBe("Model is now Grok 4.6.");
  });

  it("switches on a unique fragment", async () => {
    const h = host();
    await clientCommand("model")!.run(h, context(), "glm");
    expect(h.calls).toEqual(["model:zai/glm-5.3-flash"]);
  });

  it("refuses an ambiguous or unknown name instead of guessing", async () => {
    const h = host();
    const ambiguous = await clientCommand("model")!.run(h, context(), "flash");
    expect(h.calls).toEqual([]);
    expect(ambiguous).toContain("Use the full id");

    const unknown = await clientCommand("model")!.run(h, context(), "opus");
    expect(h.calls).toEqual([]);
    expect(unknown).toContain("No model matches");
  });
});

describe("/new", () => {
  it("starts a session", async () => {
    const h = host();
    expect(await clientCommand("new")!.run(h, context(), "")).toBeNull();
    expect(h.calls).toEqual(["new"]);
  });
});

describe("/context", () => {
  it("reports the agent's own accounting when it can be asked", async () => {
    const message = await clientCommand("context")!.run(
      host({
        model: "grok-4.6",
        turns: 3,
        context: { used: 45000, total: 300000, usagePct: 15, messageCount: 7, turnCount: 3, compactionCount: 2 },
      }),
      context({ modelId: null, usage: { used: 999, size: 1 } }),
      "",
    );
    expect(message).toContain("Model grok-4.6");
    expect(message).toContain("45K / 300K tokens (15%)");
    expect(message).toContain("3 turns");
    expect(message).toContain("7 messages");
    expect(message).toContain("compacted 2×");
  });

  it("resolves the agent's bare model name to the id the pickers show", async () => {
    const message = await clientCommand("context")!.run(
      host({ model: "glm-5.3-flash", context: { used: 1474, total: 300000, turnCount: 1, messageCount: 3 } }),
      context({ modelId: null }),
      "",
    );
    expect(message).toContain("Model zai/glm-5.3-flash");
    expect(message).toContain("1,474 / 300K tokens (0%)");
  });

  it("reports the window the agent gave, with the share in use", async () => {
    const message = await clientCommand("context")!.run(
      host(),
      context({ usage: { used: 12000, size: 300000 } }),
      "",
    );
    expect(message).toMatch(/12K \/ .*tokens \(4%\)/);
  });

  it("falls back to the model's window and says so when no turn has reported usage", async () => {
    const withoutTurn = await clientCommand("context")!.run(
      host(),
      context({ modelId: "grok-4.6", models: [{ id: "grok-4.6", name: "Grok 4.6", contextWindow: 300000 }] }),
      "",
    );
    expect(withoutTurn).toContain("No turn has reported context usage yet");

    const withWindow = await clientCommand("context")!.run(
      host(),
      context({ models: [{ id: "grok-4.6", name: "Grok 4.6", contextWindow: 300000 }], usage: { used: 1500 } }),
      "",
    );
    expect(withWindow).toMatch(/1,500 \/ .*tokens \(1%\)/);
  });
});

describe("/always-approve", () => {
  it("toggles the setting the window owns", async () => {
    const h = host();
    expect(await clientCommand("always-approve")!.run(h, context({ alwaysApprove: false }), "")).toContain("is on");
    expect(h.calls).toEqual(["yolo:true"]);
  });

  it("accepts an explicit value and refuses anything else", async () => {
    const h = host();
    const off = await clientCommand("always-approve")!.run(h, context({ alwaysApprove: true }), "off");
    expect(h.calls).toEqual(["yolo:false"]);
    expect(off).toContain("is off");

    const usage = await clientCommand("always-approve")!.run(h, context(), "maybe");
    expect(usage).toBe("Usage: /always-approve on|off");
    expect(h.calls).toEqual(["yolo:false"]);
  });
});
