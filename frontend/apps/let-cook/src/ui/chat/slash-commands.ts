/**
 * Slash commands the window answers itself.
 *
 * The agent's catalog (`x.ai/commands/list`) covers everything it resolves at turn start — `/goal`,
 * `/compact`, `/workflow`, every skill name — and those travel as an ordinary prompt. This table is
 * the other half: commands whose effect is an ACP call the renderer has to make, such as switching
 * the session mode or the model. `/plan` has no agent-side counterpart at all.
 */
import type { CommandSummary, ModelSummary, SessionInfo } from "../../acp/xai";

export interface SlashCommandHost {
  setPlanMode(enabled: boolean): Promise<void>;
  setModel(modelId: string): Promise<void>;
  setYolo(enabled: boolean): Promise<void>;
  newSession(): Promise<void>;
  /** Fork the active session (`C-sess-fork` / `/fork`) and load the child. */
  forkSession(): Promise<string>;
  /** Export the active transcript as Markdown (`/export`). */
  exportTranscript(): Promise<void>;
  sendPrompt(text: string): Promise<unknown>;
  /** `x.ai/session/info`, or `null` when the agent cannot report it. */
  sessionInfo(): Promise<SessionInfo | null>;
  /** Open the plan review popup (the TUI's `/view-plan`). */
  openPlan(): void;
  /** Open the compact Activity panel (`/tasks`, `/dashboard` — map §10 TK-*). */
  openActivity(): void;
  /** Open Settings → Memory (`MEM-ui` / `/memory`). */
  openMemory(): void;
  /** Open the `/rewind` picker (`MEM-rew` / `C-rew`). */
  openRewind(): void;
  /** Fire `/recap` and show the result dialog (`C-recap`). */
  openRecap(): void | Promise<void>;
}

export interface SlashCommandContext {
  sessionId: string | null;
  modelId: string | null;
  planMode: boolean;
  alwaysApprove: boolean;
  /** Context occupancy as `used`/`size` tokens, from `x.ai/session/info` or a `usage_update`. */
  usage: Record<string, unknown> | null;
  models: ModelSummary[];
  /** Whether the session holds a plan to show (`/view-plan`). */
  hasPlan: boolean;
  /** `InitializeResponse.meta.cancelRewind` — gates `/rewind`. */
  cancelRewindEnabled: boolean;
  /** `InitializeResponse.meta.sessionRecap` — gates `/recap`. */
  sessionRecapEnabled: boolean;
}

export interface SlashCommandSpec {
  name: string;
  /** Extra names the command answers to, as the TUI's `/view-plan` offers `show-plan` and `plan-view`. */
  aliases?: string[];
  description: string;
  inputHint?: string;
  /** `null` when the command already made its effect visible (a prompt, a new session). */
  run: (host: SlashCommandHost, context: SlashCommandContext, args: string) => Promise<string | null>;
}

export interface SlashEntry {
  name: string;
  description?: string;
  inputHint?: string;
  source: "client" | "agent";
}

export const CLIENT_COMMANDS: SlashCommandSpec[] = [
  {
    name: "plan",
    description: "Enter plan mode: inspect and propose before changing files",
    inputHint: "[what to plan]",
    run: async (host, context, args) => {
      if (context.planMode) {
        return "Already in plan mode. Turn it off in the status bar to go back to editing.";
      }
      await host.setPlanMode(true);
      if (!args) return "Plan mode is on. Cook will propose a plan before changing anything.";
      await host.sendPrompt(args);
      return null;
    },
  },
  {
    name: "model",
    description: "Switch the active model",
    inputHint: "<name>",
    run: async (host, context, args) => {
      if (!args) {
        if (context.models.length === 0) return "The agent has not reported a model catalog yet.";
        return `Models: ${context.models.map((model) => model.id).join(", ")}. Use /model <id>.`;
      }
      const resolved = resolveModel(context.models, args);
      if (typeof resolved === "string") return resolved;
      await host.setModel(resolved.id);
      return `Model is now ${resolved.name ?? resolved.id}.`;
    },
  },
  {
    name: "new",
    description: "Start a new conversation",
    run: async (host) => {
      await host.newSession();
      return null;
    },
  },
  {
    // Map id `C-sess-fork` / `/fork`: peer session via `x.ai/session/fork`, then load.
    name: "fork",
    description: "Fork this conversation into a new session",
    run: async (host, context) => {
      if (!context.sessionId) return "Start a conversation before forking.";
      await host.forkSession();
      return null;
    },
  },
  {
    // Map id `/export`: Markdown of user/assistant transcript text (no tool dumps).
    name: "export",
    description: "Export this conversation as Markdown",
    run: async (host, context) => {
      if (!context.sessionId) return "No active session to export.";
      await host.exportTranscript();
      return "Exported conversation as Markdown.";
    },
  },
  {
    // The agent answers `/context` with an empty turn: it builds the panel client-side in the TUI,
    // so the window reports it from `x.ai/session/info` plus the state it already holds.
    name: "context",
    description: "Show context window usage and session stats",
    run: async (host, context) => {
      const info = await host.sessionInfo();
      const agent = info?.context;
      // The agent names its model bare (`deepseek-flash`); the catalog namespaces it by provider,
      // so resolve against the catalog to report the same id the pickers show.
      const model = resolveCatalogModel(context.models, info?.model ?? context.modelId);
      const modelId = model?.id ?? info?.model ?? context.modelId;
      const used = tokenCount(agent?.used) ?? tokenCount(context.usage?.used);
      const size = tokenCount(agent?.total)
        ?? tokenCount(context.usage?.size)
        ?? model?.contextWindow
        ?? null;
      const facts = [
        modelId ? `Model ${modelId}` : null,
        context.sessionId ? `Session ${context.sessionId}` : "No session yet",
        used === null
          ? "No turn has reported context usage yet"
          : size === null
            ? `${formatTokens(used)} tokens in context`
            : `${formatTokens(used)} / ${formatTokens(size)} tokens (${usagePercent(used, size, agent?.usagePct)}%)`,
        countLabel(agent?.turnCount ?? info?.turns, "turn"),
        countLabel(agent?.messageCount, "message"),
        typeof agent?.compactionCount === "number" && agent.compactionCount > 0
          ? `compacted ${agent.compactionCount}×`
          : null,
        context.planMode ? "Plan mode on" : null,
        context.alwaysApprove ? "Always-approve on" : null,
      ];
      return facts.filter((fact): fact is string => fact !== null).join(" · ");
    },
  },
  {
    // Like `/context`, the agent's own `/always-approve` reports nothing over the wire.
    name: "always-approve",
    description: "Toggle always-approve (run tools without permission prompts)",
    inputHint: "on|off",
    run: async (host, context, args) => {
      const enabled = parseToggle(args, context.alwaysApprove);
      if (enabled === null) return "Usage: /always-approve on|off";
      await host.setYolo(enabled);
      return enabled
        ? "Always-approve is on: tools run without asking."
        : "Always-approve is off: tools ask before running.";
    },
  },
  {
    // `slash/commands/view_plan.rs`: the TUI's `/view-plan` opens the saved plan preview.
    name: "view-plan",
    aliases: ["show-plan", "plan-view"],
    description: "View the current plan",
    run: async (host, context) => {
      if (!context.hasPlan) return "No plan yet. Enter plan mode with /plan and let Cook write one.";
      host.openPlan();
      return null;
    },
  },
  {
    // Map ids TK-dock / C-task-list: open the compact Activity panel.
    name: "tasks",
    description: "Show background tasks and subagents",
    run: async (host) => {
      host.openActivity();
      return null;
    },
  },
  {
    // Map id TK-dash: same compact panel as `/tasks`.
    name: "dashboard",
    aliases: ["agents-dashboard", "sessions"],
    description: "Open the activity dashboard",
    run: async (host) => {
      host.openActivity();
      return null;
    },
  },
  {
    // Map ids `MEM-ui` / `/memory`: Settings memory browser; agent `/memory` refreshes U-memf.
    name: "memory",
    aliases: ["mem"],
    description: "Open the memory browser",
    run: async (host) => {
      host.openMemory();
      await host.sendPrompt("/memory");
      return null;
    },
  },
  {
    // Map ids `MEM-rew` / `C-rew`: picker over `x.ai/rewind/points` → execute → `session/load`.
    name: "rewind",
    aliases: ["undo"],
    description: "Rewind to a previous turn",
    run: async (host, context) => {
      if (!context.cancelRewindEnabled) return "Rewind is disabled for this agent.";
      if (!context.sessionId) return "Start a conversation before rewinding.";
      host.openRewind();
      return null;
    },
  },
  {
    // Map id `C-recap`: `x.ai/recap` then show the summary dialog.
    name: "recap",
    aliases: ["summarize"],
    description: "Summarize the session so far (where was I)",
    run: async (host, context) => {
      if (!context.sessionRecapEnabled) return "Session recap is disabled for this agent.";
      if (!context.sessionId) return "Start a conversation before asking for a recap.";
      await host.openRecap();
      return null;
    },
  },
];

export function clientCommand(name: string): SlashCommandSpec | undefined {
  const needle = name.toLowerCase();
  return CLIENT_COMMANDS.find((command) => command.name === needle || command.aliases?.includes(needle));
}

/**
 * `null` unless the text is a leading `/name`. The name may not contain a separator, which keeps a
 * pasted path (`/src/main.rs`) an ordinary prompt — the same test the agent applies at turn start.
 */
export function parseSlash(text: string): { name: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  const split = body.search(/\s/);
  const name = split === -1 ? body : body.slice(0, split);
  const args = split === -1 ? "" : body.slice(split).trim();
  if (name === "" || name.includes("/") || name.includes("\\")) return null;
  return { name: name.toLowerCase(), args };
}

/** The composer's dropdown: the window's own commands first, then the agent's, deduped by name. */
export function slashEntries(
  commands: CommandSummary[],
  gates: { cancelRewindEnabled?: boolean; sessionRecapEnabled?: boolean } = {},
): SlashEntry[] {
  const cancelRewindEnabled = gates.cancelRewindEnabled !== false;
  const sessionRecapEnabled = gates.sessionRecapEnabled === true;
  const client: SlashEntry[] = CLIENT_COMMANDS
    .filter((command) => {
      if (command.name === "rewind") return cancelRewindEnabled;
      if (command.name === "recap") return sessionRecapEnabled;
      return true;
    })
    .map((command) => ({
      name: command.name,
      description: command.description,
      inputHint: command.inputHint,
      source: "client" as const,
    }));
  const taken = new Set(client.map((entry) => entry.name));
  const agent: SlashEntry[] = commands
    .filter((command) => command.name && !taken.has(command.name.toLowerCase()))
    .map((command) => ({
      name: command.name,
      description: command.description,
      inputHint: command.inputHint,
      source: "agent" as const,
    }));
  return [...client, ...agent];
}

/** Prefix matches rank above substring ones, so `/p` offers `/plan` before `/compact`. */
export function matchSlashCommands(entries: SlashEntry[], query: string, limit = 8): SlashEntry[] {
  const needle = query.toLowerCase();
  const ranked = entries
    .map((entry) => ({ entry, name: entry.name.toLowerCase() }))
    .filter((candidate) => candidate.name.includes(needle))
    .sort((a, b) => {
      const distance = Number(!a.name.startsWith(needle)) - Number(!b.name.startsWith(needle));
      if (distance !== 0) return distance;
      if (a.name.length !== b.name.length) return a.name.length - b.name.length;
      return a.name.localeCompare(b.name);
    });
  return ranked.slice(0, limit).map((candidate) => candidate.entry);
}

/** `null` for an unrecognised argument, so the caller reports usage instead of guessing. */
function parseToggle(args: string, current: boolean): boolean | null {
  const value = args.trim().toLowerCase();
  if (!value) return !current;
  if (["on", "true", "1", "yes", "enable"].includes(value)) return true;
  if (["off", "false", "0", "no", "disable"].includes(value)) return false;
  return null;
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The agent's own percentage when it sent one, otherwise the share of the window in use. */
function usagePercent(used: number, size: number, reported?: number): number {
  if (typeof reported === "number" && Number.isFinite(reported)) return Math.round(reported);
  return size > 0 ? Math.min(100, Math.round((used / size) * 100)) : 0;
}

function countLabel(value: unknown, noun: string): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

/** The catalog entry for an id the agent named, which may be bare, namespaced, or absent. */
function resolveCatalogModel(models: ModelSummary[], id: string | null): ModelSummary | null {
  if (!id) return null;
  const lower = id.toLowerCase();
  return models.find((model) => model.id.toLowerCase() === lower)
    ?? models.find((model) => model.id.toLowerCase().endsWith(`/${lower}`))
    ?? null;
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value > 9999 ? "compact" : "standard" }).format(value);
}

/** An exact id or name wins; otherwise a unique substring does. A string result is the message. */
function resolveModel(models: ModelSummary[], query: string): ModelSummary | string {  const needle = query.trim();
  const lower = needle.toLowerCase();
  const exact = models.find((model) => model.id.toLowerCase() === lower)
    ?? models.find((model) => model.name?.toLowerCase() === lower);
  if (exact) return exact;
  const partial = models.filter(
    (model) => model.id.toLowerCase().includes(lower) || model.name?.toLowerCase().includes(lower),
  );
  if (partial.length === 1) return partial[0];
  if (partial.length === 0) {
    return `No model matches “${needle}”. Available: ${models.map((model) => model.id).join(", ")}.`;
  }
  return `“${needle}” matches ${partial.map((model) => model.id).join(", ")}. Use the full id.`;
}
