import { beforeEach, describe, expect, it } from "vitest";
import { mockRequest, mockRequests, mockReset, mockState } from "./mock-transport";

describe("MCP mock connectors (P2)", () => {
  beforeEach(() => mockReset());

  it("toggles a tool and deletes a server", async () => {
    await mockRequest("_x.ai/mcp/toggle_tool", {
      sessionId: "mock-session",
      serverName: "filesystem",
      toolName: "list_dir",
      enabled: true,
    });
    expect(mockState().mcpServers.find((server) => server.name === "filesystem")?.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "list_dir", enabled: true })]),
    );

    await mockRequest("_x.ai/mcp/delete", { sessionId: "mock-session", serverName: "linear" });
    expect(mockState().mcpServers.map((server) => server.name)).toEqual(["filesystem"]);
    expect(mockRequests().map((entry) => entry.method)).toEqual([
      "x.ai/mcp/toggle_tool",
      "x.ai/mcp/delete",
    ]);
  });

  it("reports auth status and completes setup", async () => {
    mockReset({
      mcpServers: [
        {
          name: "slack",
          transport: "http",
          url: "https://mcp.slack.example/sse",
          enabled: false,
          toolCount: 0,
          tools: [],
          authRequired: true,
        },
        {
          name: "notion",
          transport: "stdio",
          command: "npx",
          args: ["notion-mcp"],
          enabled: false,
          toolCount: 0,
          tools: [],
          setupRequired: true,
          setup: { fields: [{ id: "workspace", label: "Workspace", type: "select", options: [{ label: "Team", value: "team" }] }] },
        },
      ],
    });

    const status = await mockRequest<{ result: { servers: Array<{ serverName: string; status: string }> } }>(
      "_x.ai/mcp/auth_status",
      { sessionId: "mock-session", serverName: "slack" },
    );
    expect(status.result.servers).toEqual([{ serverName: "slack", status: "auth_required" }]);

    const auth = await mockRequest<{ result: { status: string } }>("_x.ai/mcp/auth_trigger", {
      sessionId: "mock-session",
      serverName: "slack",
    });
    expect(auth.result.status).toBe("authenticated");
    expect(mockState().mcpServers.find((server) => server.name === "slack")?.authRequired).toBe(false);

    await mockRequest("_x.ai/mcp/setup", {
      sessionId: "mock-session",
      serverName: "notion",
      values: { workspace: "team" },
    });
    const notion = mockState().mcpServers.find((server) => server.name === "notion");
    expect(notion?.setupRequired).toBe(false);
    expect(notion?.setupValues).toEqual({ workspace: "team" });
  });
});
