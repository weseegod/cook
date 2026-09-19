import { describe, expect, it } from "vitest";
import { normalizeSkill } from "./extensions";
import { mergeMcpCatalog, mcpServersFromParams } from "./mcp-servers";

describe("normalizeSkill", () => {
  // `SkillInfo` has no `rename_all`, so the live agent sends snake_case for these fields.
  it("reads the snake_case fields the live agent sends", () => {
    expect(
      normalizeSkill({
        name: "commit",
        display_name: "Commit",
        description: "Write a conventional commit",
        scope: "bundled",
        path: "/home/demo/.cook/bundled/skills/commit/SKILL.md",
        plugin_name: "cook-core",
        when_to_use: "committing staged changes",
      }),
    ).toEqual({
      name: "commit",
      displayName: "Commit",
      description: "Write a conventional commit",
      enabled: true,
      scope: "bundled",
      path: "/home/demo/.cook/bundled/skills/commit/SKILL.md",
      pluginName: "cook-core",
      source: undefined,
      whenToUse: "committing staged changes",
    });
  });

  it("prefers camelCase when a caller already normalized, and defaults enabled", () => {
    const skill = normalizeSkill({ name: "review", displayName: "Review", enabled: false });
    expect(skill.displayName).toBe("Review");
    expect(skill.enabled).toBe(false);
  });
});

describe("mcpServersFromParams", () => {
  it("keeps `source_label` so a plugin-owned server lands in its own section", () => {
    const servers = mcpServersFromParams({
      servers: [{ name: "acme-search", source: "local", source_label: "plugin: acme", type: "stdio", command: "npx" }],
    });
    expect(servers?.[0]).toMatchObject({ name: "acme-search", source: "local", sourceLabel: "plugin: acme" });
  });

  it("keeps `display_name` so a managed gateway card can title itself", () => {
    const servers = mcpServersFromParams({
      servers: [{
        name: "managed_gateway:cursor",
        display_name: "Cursor",
        type: "managedGateway",
        source: "managed",
      }],
    });
    expect(servers?.[0]).toMatchObject({
      name: "managed_gateway:cursor",
      displayName: "Cursor",
      type: "managedGateway",
    });
  });

  it("reads the live flattened shape (type + command + session.tools)", () => {
    const servers = mcpServersFromParams({
      servers: [
        {
          name: "filesystem",
          source: "local",
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
          session: {
            enabled: true,
            status: "ready",
            tools: [{ name: "read_file", enabled: true, displayName: "Read file", description: "Reads a file" }],
          },
        },
      ],
    });

    expect(servers).toEqual([
      {
        name: "filesystem",
        displayName: undefined,
        source: "local",
        sourceLabel: undefined,
        type: "stdio",
        url: undefined,
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem"],
        setup: undefined,
        setupValues: undefined,
        session: {
          enabled: true,
          status: "ready",
          tools: [{ name: "read_file", enabled: true, displayName: "Read file", description: "Reads a file" }],
          authRequired: false,
          setupRequired: false,
          blockedReason: undefined,
        },
      },
    ]);
  });
});

describe("mergeMcpCatalog", () => {
  const withTools = {
    name: "filesystem",
    session: {
      enabled: true,
      status: "ready",
      tools: [{ name: "read_file", enabled: true }, { name: "list_dir", enabled: false }],
    },
  };

  it("keeps the tools already on screen when a refetch is not yet session-annotated", () => {
    // The agent-level catalog answers `x.ai/mcp/list` with `status: undefined` and no tools
    // before the session pool is annotated; blanking the rows mid-toggle would be a regression.
    const merged = mergeMcpCatalog([withTools], [
      { name: "filesystem", session: { enabled: true, tools: [] } },
    ]);
    expect(merged[0].session?.tools).toHaveLength(2);
  });

  it("accepts a genuinely emptier annotated list", () => {
    const merged = mergeMcpCatalog([withTools], [
      { name: "filesystem", session: { enabled: true, status: "ready", tools: [] } },
    ]);
    expect(merged[0].session?.tools).toEqual([]);
  });

  it("passes through a server the catalog has never seen", () => {
    const fresh = { name: "linear", session: { enabled: false, tools: [] } };
    expect(mergeMcpCatalog([withTools], [fresh])).toEqual([fresh]);
  });
});
