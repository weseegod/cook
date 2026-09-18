import { beforeEach, describe, expect, it } from "vitest";
import { useCatalogStore } from "../../state/catalog";
import { useSessionStore } from "../../state/session";
import { dispatchNotification, mcpServersFromParams } from "./index";

describe("notification registry (C3)", () => {
  beforeEach(() => {
    useCatalogStore.getState().setMcpServers([]);
    useSessionStore.getState().resetConversation("s1");
  });

  it("updates connectors catalog from servers_updated without a list round trip", async () => {
    await dispatchNotification(
      { method: "x.ai/mcp/servers_updated", params: {} },
      "x.ai/mcp/servers_updated",
      {
        servers: [
          {
            name: "filesystem",
            type: "stdio",
            command: "npx",
            session: { enabled: true, status: "ready", tools: [{ name: "read" }] },
          },
        ],
      },
    );
    expect(useCatalogStore.getState().mcpServers).toEqual([
      expect.objectContaining({
        name: "filesystem",
        session: expect.objectContaining({ status: "ready", tools: [{ name: "read" }] }),
      }),
    ]);
  });

  it("accepts mcpServers payload shape from the agent", () => {
    const servers = mcpServersFromParams({
      mcpServers: [{ name: "slack", source: "managed", type: "http", url: "https://example" }],
    });
    expect(servers?.[0]?.name).toBe("slack");
  });

  it("finalizes a running turn on prompt_complete", async () => {
    useSessionStore.setState({
      turnRunning: true,
      turnStartedAt: Date.now() - 1000,
      transcriptCursor: {
        turnId: "turn-1",
        assistantId: null,
        thoughtId: null,
        optimisticUserId: null,
      },
      blocks: [
        {
          type: "message",
          id: "m1",
          turnId: "turn-1",
          role: "assistant",
          text: "done",
          images: [],
          streaming: true,
        },
      ],
    });
    await dispatchNotification(
      { method: "x.ai/session/prompt_complete", params: {} },
      "x.ai/session/prompt_complete",
      { stopReason: "end_turn" },
    );
    const state = useSessionStore.getState();
    expect(state.turnRunning).toBe(false);
    expect(state.turnStartedAt).toBeNull();
    expect(state.blocks.at(-1)).toMatchObject({ type: "session-event", kind: "turn" });
  });

  it("does not throw or -32601 on an unknown notification", async () => {
    await expect(
      dispatchNotification(
        { method: "x.ai/announcements/update", params: {} },
        "x.ai/announcements/update",
        {},
      ),
    ).resolves.toBeUndefined();
  });
});
