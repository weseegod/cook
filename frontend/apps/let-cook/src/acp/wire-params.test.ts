import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as Array<{ method: string; params: Record<string, unknown> }>);

vi.mock("./host", () => ({
  request: vi.fn(async (method: string, params: unknown) => {
    calls.push({ method, params: params as Record<string, unknown> });
    if (method === "x.ai/skills/list") return { skills: [] };
    if (method === "x.ai/skills/toggle") return { ok: true };
    return { ok: true, servers: [], workflows: [] };
  }),
}));

import {
  deleteConnector,
  listSkills,
  mcpAuthStatus,
  mcpAuthTrigger,
  toggleConnector,
  toggleConnectorTool,
  upsertConnector,
} from "./extensions";

/**
 * The shell decodes the mutating `x.ai/mcp/*` methods as snake_case (no `rename_all`), while
 * `x.ai/mcp/list` and `x.ai/mcp/setup` are camelCase. Sending one casing only fails against the
 * live agent while the mock stays green, so both travel in one params object.
 */
describe("MCP wire params", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("sends both casings for server toggle, tool toggle, delete and upsert", async () => {
    await toggleConnector("s-1", "filesystem", false);
    await toggleConnectorTool("s-1", "filesystem", "list_dir", true);
    await deleteConnector("s-1", "linear");
    await upsertConnector("s-1", "github", { type: "stdio", command: "npx", args: ["-y", "server-github"] });

    expect(calls[0]).toMatchObject({
      method: "x.ai/mcp/toggle",
      params: { sessionId: "s-1", session_id: "s-1", serverName: "filesystem", server_name: "filesystem", enabled: false },
    });
    expect(calls[1]).toMatchObject({
      method: "x.ai/mcp/toggle_tool",
      params: {
        sessionId: "s-1",
        session_id: "s-1",
        serverName: "filesystem",
        server_name: "filesystem",
        toolName: "list_dir",
        tool_name: "list_dir",
        enabled: true,
      },
    });
    expect(calls[2]).toMatchObject({
      method: "x.ai/mcp/delete",
      params: { sessionId: "s-1", session_id: "s-1", serverName: "linear", server_name: "linear" },
    });
    expect(calls[3]).toMatchObject({
      method: "x.ai/mcp/upsert",
      params: { session_id: "s-1", server_name: "github", type: "stdio", command: "npx" },
    });
  });

  it("sends both casings for auth status and auth trigger", async () => {
    await mcpAuthStatus("s-1", "slack");
    await mcpAuthTrigger("s-1", "slack");

    expect(calls[0].params).toMatchObject({ sessionId: "s-1", session_id: "s-1", serverName: "slack", server_name: "slack" });
    expect(calls[1].params).toMatchObject({ sessionId: "s-1", session_id: "s-1", serverName: "slack", server_name: "slack" });
  });
});

describe("skills wire params", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  // `SkillsListRequest.cwd` is a required string: an omitted cwd is a deserialize failure, not a
  // default, so the request must always carry one.
  it("always sends a cwd, falling back to the workspace dot", async () => {
    await listSkills();
    expect(calls[0]).toMatchObject({ method: "x.ai/skills/list", params: { cwd: "." } });

    await listSkills("/home/demo/project");
    expect(calls[1]).toMatchObject({ method: "x.ai/skills/list", params: { cwd: "/home/demo/project" } });
  });
});
