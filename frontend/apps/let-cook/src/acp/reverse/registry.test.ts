import { beforeEach, describe, expect, it, vi } from "vitest";
import { planDialogTitle } from "../../state/plan-review";
import { useSessionStore } from "../../state/session";
import * as host from "../host";
import { dispatchReverseRequest, lookupReverse, unknownReverseAnswer } from "./index";

describe("reverse-request policy (C2)", () => {
  beforeEach(() => {
    useSessionStore.getState().resetConversation();
    useSessionStore.setState({ interactionsBySession: {}, sessionAlerts: {}, toasts: [], error: null });
    vi.restoreAllMocks();
  });

  it("parks a permission card for session/request_permission", async () => {
    const respond = vi.spyOn(host, "respond").mockResolvedValue();
    await dispatchReverseRequest(
      {
        id: 9,
        method: "session/request_permission",
        params: {
          sessionId: "s1",
          toolCall: { title: "Run", kind: "execute" },
          options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
        },
      },
      "session/request_permission",
      {
        sessionId: "s1",
        toolCall: { title: "Run", kind: "execute" },
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
      },
    );
    expect(useSessionStore.getState().pendingPermission?.rpcId).toBe(9);
    expect(respond).not.toHaveBeenCalled();
  });

  it("does not return -32601 for an unknown reverse with id", async () => {
    const respond = vi.spyOn(host, "respond").mockResolvedValue();
    await dispatchReverseRequest(
      { id: 42, method: "x.ai/totally/unknown", params: {} },
      "x.ai/totally/unknown",
      {},
    );
    expect(respond).toHaveBeenCalledWith(42, { ok: false });
    expect(respond.mock.calls[0]?.[2]).toBeUndefined();
  });

  it("declines x.ai/mcp/sdk_call with { ok: false }, not -32601", async () => {
    expect(lookupReverse("x.ai/mcp/sdk_call")?.mapId).toBe("R-sdk");
    const respond = vi.spyOn(host, "respond").mockResolvedValue();
    await dispatchReverseRequest(
      { id: 7, method: "x.ai/mcp/sdk_call", params: {} },
      "x.ai/mcp/sdk_call",
      {},
    );
    expect(respond).toHaveBeenCalledWith(7, { ok: false });
  });

  it("keeps notifications off the request path", () => {
    const answer = unknownReverseAnswer("x.ai/mcp/servers_updated");
    expect(answer.error).toBeUndefined();
    expect(answer.result).toEqual({ ok: false });
  });

  it("parks a plan review under the episode's plan filename from planFilePath", async () => {
    vi.spyOn(host, "respond").mockResolvedValue();
    const params = {
      sessionId: "s1",
      toolCallId: "tc-1",
      planContent: "# Plan",
      planFilePath: "/home/u/.cook/sessions/p/abc/plans/2026-09-19T14-30-22Z.md",
    };
    await dispatchReverseRequest(
      { id: 11, method: "x.ai/exit_plan_mode", params },
      "x.ai/exit_plan_mode",
      params,
    );
    expect(useSessionStore.getState().planReview).toEqual({
      body: "# Plan",
      fileName: "2026-09-19T14-30-22Z.md",
      pending: true,
    });
  });

  it("titles a planFilePath-less review from its H1", async () => {
    vi.spyOn(host, "respond").mockResolvedValue();
    const params = { sessionId: "s1", toolCallId: "tc-1", planContent: "# Plan" };
    await dispatchReverseRequest(
      { id: 12, method: "x.ai/exit_plan_mode", params },
      "x.ai/exit_plan_mode",
      params,
    );
    // Agents that predate per-episode plan files send no planFilePath; the H1 still owns the title.
    expect(planDialogTitle(useSessionStore.getState().planReview)).toBe("Plan");
  });

  it("falls back to the legacy plan name when the request carries no body", async () => {
    vi.spyOn(host, "respond").mockResolvedValue();
    const params = { sessionId: "s1", toolCallId: "tc-2", planContent: "   " };
    await dispatchReverseRequest(
      { id: 13, method: "x.ai/exit_plan_mode", params },
      "x.ai/exit_plan_mode",
      params,
    );
    expect(planDialogTitle(useSessionStore.getState().planReview)).toBe("plan.md (empty)");
  });

  it("parks exit_plan_mode for a background session without painting the open conversation", async () => {
    const respond = vi.spyOn(host, "respond").mockResolvedValue();
    useSessionStore.getState().resetConversation("visible");
    useSessionStore.getState().beginPlanReview("# On screen", "visible.md");
    useSessionStore.getState().set({
      pendingQuestion: { rpcId: 20, kind: "plan", questions: [], raw: {} },
    });

    const params = {
      sessionId: "background",
      toolCallId: "tc-bg",
      planContent: "# Background plan",
      planFilePath: "/plans/background.md",
    };
    await dispatchReverseRequest(
      { id: 21, method: "x.ai/exit_plan_mode", params },
      "x.ai/exit_plan_mode",
      params,
    );

    expect(respond).not.toHaveBeenCalled();
    expect(useSessionStore.getState().planReview).toEqual({
      body: "# On screen",
      fileName: "visible.md",
      pending: true,
    });
    expect(useSessionStore.getState().pendingQuestion?.rpcId).toBe(20);
    expect(useSessionStore.getState().planReviewsBySession.background).toMatchObject({
      planReview: { body: "# Background plan", fileName: "background.md", pending: true },
      pendingQuestion: { rpcId: 21, kind: "plan" },
    });
  });

  it("parks a background ask with its conversation instead of the open card", async () => {
    const respond = vi.spyOn(host, "respond").mockResolvedValue();
    useSessionStore.getState().resetConversation("visible");
    useSessionStore.getState().set({
      pendingQuestion: { rpcId: 20, kind: "question", questions: [], raw: {} },
    });

    const params = { sessionId: "background", toolCallId: "tc-bg", questions: [] };
    await dispatchReverseRequest(
      { id: 21, method: "x.ai/ask_user_question", params },
      "x.ai/ask_user_question",
      params,
    );

    expect(respond).not.toHaveBeenCalled();
    // The open conversation keeps its own card; the background one waits with its session.
    expect(useSessionStore.getState().pendingQuestion?.rpcId).toBe(20);
    expect(useSessionStore.getState().interactionsBySession.background?.question?.rpcId).toBe(21);
    expect(useSessionStore.getState().toasts[0]).toMatchObject({
      tone: "info",
      sessionId: "background",
    });
  });

  it("parks a background permission request without painting the open conversation", async () => {
    vi.spyOn(host, "respond").mockResolvedValue();
    useSessionStore.getState().resetConversation("visible");

    const params = {
      sessionId: "background",
      toolCall: { title: "Run", kind: "execute" },
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
    };
    await dispatchReverseRequest(
      { id: 30, method: "session/request_permission", params },
      "session/request_permission",
      params,
    );

    expect(useSessionStore.getState().pendingPermission).toBeNull();
    expect(useSessionStore.getState().interactionsBySession.background?.permission?.rpcId).toBe(30);
  });

  it("restores a parked card when its conversation is opened again", () => {
    const store = useSessionStore.getState();
    store.resetConversation("visible");
    useSessionStore.getState().set({
      pendingQuestion: { rpcId: 20, kind: "question", questions: [], raw: {} },
    });

    // The agent is still parked on the request, so leaving the conversation must not drop it.
    useSessionStore.getState().resetConversation("other");
    expect(useSessionStore.getState().pendingQuestion).toBeNull();
    expect(useSessionStore.getState().interactionsBySession.visible?.question?.rpcId).toBe(20);

    useSessionStore.getState().resetConversation("visible");
    useSessionStore.getState().restoreStashedInteractions();
    expect(useSessionStore.getState().pendingQuestion?.rpcId).toBe(20);
    expect(useSessionStore.getState().interactionsBySession.visible).toBeUndefined();
  });

  it("keeps folder trust on screen across a conversation switch", () => {
    const store = useSessionStore.getState();
    store.resetConversation("visible");
    useSessionStore.getState().set({
      pendingQuestion: { rpcId: 40, kind: "trust", questions: [], raw: {} },
    });

    useSessionStore.getState().resetConversation("other");
    // Trust is about the workspace, so it is neither parked nor dropped.
    expect(useSessionStore.getState().pendingQuestion?.rpcId).toBe(40);
    expect(useSessionStore.getState().interactionsBySession.visible).toBeUndefined();
  });
});
