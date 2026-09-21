import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCatalogStore } from "../../state/catalog";
import { useSessionStore } from "../../state/session";
import { dispatchNotification, mcpServersFromParams } from "./index";

const notifyMocks = vi.hoisted(() => ({
  notifyTurnComplete: vi.fn(async () => undefined),
  shouldNotifyTurnComplete: vi.fn(() => false),
}));

vi.mock("../os-notify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../os-notify")>();
  return {
    ...actual,
    notifyTurnComplete: notifyMocks.notifyTurnComplete,
    shouldNotifyTurnComplete: notifyMocks.shouldNotifyTurnComplete,
  };
});

describe("notification registry (C3)", () => {
  beforeEach(() => {
    useCatalogStore.getState().setMcpServers([]);
    useSessionStore.getState().resetConversation("s1");
    notifyMocks.notifyTurnComplete.mockClear();
    notifyMocks.shouldNotifyTurnComplete.mockReset();
    notifyMocks.shouldNotifyTurnComplete.mockReturnValue(false);
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
        session: expect.objectContaining({
          status: "ready",
          tools: [expect.objectContaining({ name: "read", enabled: true })],
        }),
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
    expect(notifyMocks.notifyTurnComplete).not.toHaveBeenCalled();
  });

  it("ignores prompt_complete for a background session and only clears its working row", async () => {
    useSessionStore.setState({
      sessionId: "active",
      turnRunning: true,
      turnStartedAt: Date.now() - 500,
      workingSessions: {
        background: { startedAt: Date.now() - 2_000, activity: null },
      },
      blocks: [
        {
          type: "message",
          id: "m-active",
          turnId: "turn-active",
          role: "assistant",
          text: "still going",
          images: [],
          streaming: true,
        },
      ],
    });
    await dispatchNotification(
      { method: "x.ai/session/prompt_complete", params: {} },
      "x.ai/session/prompt_complete",
      { sessionId: "background", stopReason: "end_turn" },
    );
    const state = useSessionStore.getState();
    expect(state.turnRunning).toBe(true);
    expect(state.turnStartedAt).not.toBeNull();
    expect(state.workingSessions.background).toBeUndefined();
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({ id: "m-active", streaming: true });
  });

  it("notifies once on prompt_complete when the document is hidden", async () => {
    notifyMocks.shouldNotifyTurnComplete.mockReturnValue(true);
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
    expect(notifyMocks.notifyTurnComplete).toHaveBeenCalledTimes(1);
    expect(notifyMocks.notifyTurnComplete).toHaveBeenCalledWith("Let Cook", "Turn completed");
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

  it("stores memory_files (U-memf) in the catalog", async () => {
    await dispatchNotification(
      { method: "session/update", params: {} },
      "memory_files",
      {
        files: [
          { path: "/tmp/MEMORY.md", source: "workspace", size_bytes: 42, generated: true },
        ],
        enabled: true,
      },
    );
    expect(useCatalogStore.getState().memoryFiles).toEqual([
      expect.objectContaining({ path: "/tmp/MEMORY.md", source: "workspace", generated: true }),
    ]);
  });

  it("stores plugins_changed (U-plug) and hooks/event (N-hookev)", async () => {
    await dispatchNotification(
      { method: "session/update", params: {} },
      "plugins_changed",
      { plugins: [{ name: "demo", id: "user/aa/demo", enabled: true, version: "2.0" }] },
    );
    expect(useCatalogStore.getState().plugins[0]).toMatchObject({ name: "demo", id: "user/aa/demo" });

    await dispatchNotification(
      { method: "x.ai/hooks/event", params: {} },
      "x.ai/hooks/event",
      { hookEventName: "PreToolUse", toolName: "Bash" },
    );
    expect(useCatalogStore.getState().hookEvents[0]).toMatchObject({
      event: "PreToolUse",
      summary: expect.stringContaining("Bash"),
    });
  });
});
