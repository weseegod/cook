import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { useSessionStore, type PendingQuestion } from "../../state/session";
import { planFileName } from "../../state/plan-review";
import type { ReverseContext, ReverseDisposition, ReverseEntry } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Split question text into label (first paragraph) and description (rest).
 * Mirrors TUI `split_question_label_desc`: a paragraph break is `\n\n`.
 */
export function splitQuestionLabelDesc(text: string): { label: string; description: string } {
  const pos = text.indexOf("\n\n");
  if (pos === -1) return { label: text.trim(), description: "" };
  return {
    label: text.slice(0, pos).trim(),
    description: text.slice(pos + 2).trim(),
  };
}

function mapQuestion(
  text: string,
  index: number,
  options: Array<{ id: string; label: string; description?: string }>,
  multiSelect?: boolean,
): PendingQuestion["questions"][number] {
  const { label, description } = splitQuestionLabelDesc(text);
  return {
    question: text,
    label,
    ...(description ? { description } : {}),
    index,
    ...(multiSelect ? { multiSelect: true } : {}),
    options,
  };
}

export function questionInteraction(rpcId: number | string, raw: Record<string, unknown>): PendingQuestion {
  const questions = Array.isArray(raw.questions) ? raw.questions.filter(isRecord) : [];
  return {
    rpcId,
    title: raw.mode === "plan" ? "Plan needs your input" : "Cook has a question",
    kind: "question",
    raw,
    questions: questions.map((question, questionIndex) => {
      const text = String(question.question ?? `Question ${questionIndex + 1}`);
      const options = (Array.isArray(question.options) ? question.options.filter(isRecord) : []).map((option, optionIndex) => ({
        id: String(option.id ?? option.label ?? optionIndex),
        label: String(option.label ?? option.id ?? `Option ${optionIndex + 1}`),
        description: typeof option.description === "string" ? option.description : undefined,
      }));
      return mapQuestion(text, questionIndex, options, question.multiSelect === true);
    }),
  };
}

export function planInteraction(rpcId: number | string, raw: Record<string, unknown>): PendingQuestion {
  const hasPlan = typeof raw.planContent === "string" && raw.planContent.trim() !== "";
  const text = hasPlan
    ? "Waiting on plan approval"
    : "No plan written: approve or request changes";
  return {
    rpcId,
    kind: "plan",
    raw,
    questions: [mapQuestion(text, 0, [
      { id: "approved", label: "Approve", description: "Proceed with the plan" },
      { id: "approved_as_goal", label: "Run as goal", description: "Run the approved plan as an autonomous goal" },
      { id: "cancelled", label: "Request changes", description: "Keep planning and send feedback" },
      { id: "abandoned", label: "Quit plan", description: "Leave plan mode without executing" },
    ])],
  };
}

export function trustInteraction(rpcId: number | string, raw: Record<string, unknown>): PendingQuestion {
  const kinds = Array.isArray(raw.configKinds) ? raw.configKinds.join(", ") : "project configuration";
  const text = `${String(raw.workspace ?? raw.cwd ?? "This folder")} contains ${kinds}. Trusting it may run local hooks or MCP servers.`;
  return {
    rpcId,
    title: "Trust this workspace?",
    kind: "trust",
    raw,
    questions: [mapQuestion(text, 0, [
      { id: "trust", label: "Trust workspace" },
      { id: "reject", label: "Keep restricted" },
    ])],
  };
}

/** `x.ai/mcp/elicit`: the agent asks the user for MCP-server input or a URL visit. */
export function elicitInteraction(rpcId: number | string, raw: Record<string, unknown>): PendingQuestion {
  const server = String(raw.serverName ?? raw.server_name ?? "an MCP server");
  const message = String(raw.message ?? "This connector needs your input.");
  const url = typeof raw.url === "string" ? raw.url : undefined;
  const mode = String(raw.mode ?? "form");
  const text = url ? `${message}\n\n${url}` : message;
  return {
    rpcId,
    title: `${server} needs your input`,
    kind: "elicit",
    raw,
    questions: [mapQuestion(text, 0, [
      { id: "accept", label: url ? "Open and continue" : "Accept", description: mode === "url" ? "Open the link, then continue the tool call" : "Send this input to the connector" },
      { id: "decline", label: "Decline", description: "The connector continues without this input" },
    ])],
  };
}

function park(ctx: ReverseContext, build: (id: number | string) => void): ReverseDisposition {
  if (ctx.message.id === undefined) return { kind: "decline", result: { ok: false } };
  build(ctx.message.id);
  return { kind: "parked" };
}

/** R-ask / R-plan / R-elicit / R-trust / session/request_permission — park UI cards. */
export const interactionEntries: ReverseEntry[] = [
  {
    mapId: "R-perm",
    method: "session/request_permission",
    handle: async (ctx) =>
      park(ctx, (rpcId) => {
        useSessionStore.getState().set({
          pendingPermission: {
            rpcId,
            request: ctx.params as unknown as RequestPermissionRequest,
          },
        });
      }),
  },
  {
    mapId: "R-ask",
    method: "x.ai/ask_user_question",
    handle: async (ctx) =>
      park(ctx, (rpcId) => {
        useSessionStore.getState().set({ pendingQuestion: questionInteraction(rpcId, ctx.params) });
      }),
  },
  {
    mapId: "R-plan",
    method: "x.ai/exit_plan_mode",
    handle: async (ctx) =>
      park(ctx, (rpcId) => {
        const body = typeof ctx.params.planContent === "string" && ctx.params.planContent.trim() !== ""
          ? ctx.params.planContent
          : null;
        const planPath = typeof ctx.params.planFilePath === "string" ? ctx.params.planFilePath : null;
        const fileName = planFileName(planPath);
        const question = planInteraction(rpcId, ctx.params);
        const ownerId = typeof ctx.params.sessionId === "string" ? ctx.params.sessionId : null;
        const activeId = useSessionStore.getState().sessionId;
        // A request for a background conversation must not paint the open conversation's review.
        if (ownerId && activeId && ownerId !== activeId) {
          useSessionStore.getState().stashPlanReview(ownerId, {
            planReview: { body, fileName, pending: true },
            planComments: [],
            planNextCommentId: 0,
            planFocus: "preview",
            planCommentRange: null,
            planEditingCommentId: null,
            planStashedDraft: null,
            pendingQuestion: question,
          });
          return;
        }
        useSessionStore.getState().beginPlanReview(body, fileName);
        useSessionStore.getState().set({ pendingQuestion: question });
      }),
  },
  {
    mapId: "R-trust",
    method: "x.ai/folder_trust/request",
    handle: async (ctx) =>
      park(ctx, (rpcId) => {
        useSessionStore.getState().set({ pendingQuestion: trustInteraction(rpcId, ctx.params) });
      }),
  },
  {
    mapId: "R-elicit",
    method: "x.ai/mcp/elicit",
    handle: async (ctx) =>
      park(ctx, (rpcId) => {
        useSessionStore.getState().set({ pendingQuestion: elicitInteraction(rpcId, ctx.params) });
      }),
  },
];
