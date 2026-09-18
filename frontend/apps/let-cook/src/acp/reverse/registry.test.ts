import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "../../state/session";
import * as host from "../host";
import { dispatchReverseRequest, lookupReverse, unknownReverseAnswer } from "./index";

describe("reverse-request policy (C2)", () => {
  beforeEach(() => {
    useSessionStore.getState().resetConversation();
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
});
