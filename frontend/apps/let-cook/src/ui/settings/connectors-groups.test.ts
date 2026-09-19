import { describe, expect, it } from "vitest";
import type { McpServerView, McpToolSummary } from "../../acp/extensions";
import {
  connectorDisplayLabel,
  connectorEligibleCount,
  connectorEnabledCount,
  groupConnectors,
  visibleTools,
} from "./connectors-groups";

const tool = (over: Partial<McpToolSummary> & { name: string }): McpToolSummary => ({
  enabled: true,
  ...over,
});

const server = (over: Partial<McpServerView> & { name: string }): McpServerView => ({
  session: { enabled: true, tools: [] },
  ...over,
});

const blocked = (name: string): McpServerView =>
  server({ name, session: { enabled: false, blockedReason: "The server acme is blocked by an organization policy." } });

describe("groupConnectors", () => {
  it("titles a managed gateway from displayName under a Managed caption", () => {
    const sections = groupConnectors([
      server({
        name: "managed_gateway:cursor",
        displayName: "Cursor",
        type: "managedGateway",
        session: { enabled: true, tools: [tool({ name: "browser_navigate" })] },
      }),
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0].caption).toBe("Managed by grok.com");
    expect(sections[0].groups[0].label).toBe("Cursor");
    expect(sections[0].groups[0].key).toBe("mcp-section:managed:cursor");
  });

  it("strips managed_gateway: when displayName is missing", () => {
    expect(connectorDisplayLabel(server({ name: "managed_gateway:cursor", type: "managedGateway" }))).toBe("cursor");
  });

  it("hides gmail/mail tools on Cursor when a Gmail connector is listed", () => {
    const cursor = server({
      name: "managed_gateway:cursor",
      displayName: "Cursor",
      type: "managedGateway",
      session: {
        enabled: true,
        tools: [
          tool({ name: "browser_navigate", displayName: "Navigate" }),
          tool({ name: "gmail__search", displayName: "Search Gmail" }),
          tool({ name: "mail", displayName: "Mail" }),
        ],
      },
    });
    const gmail = server({
      name: "managed_gateway:gmail",
      displayName: "Gmail",
      type: "managedGateway",
      session: {
        enabled: true,
        tools: [tool({ name: "gmail__search", displayName: "Search Gmail" })],
      },
    });
    const catalog = [cursor, gmail];
    // `gmail__*` matches owner id; bare `mail` does not — that needs a listed mail connector.
    expect(visibleTools(cursor, catalog).map((entry) => entry.name)).toEqual([
      "browser_navigate",
      "mail",
    ]);
    expect(visibleTools(gmail, catalog).map((entry) => entry.name)).toEqual(["gmail__search"]);

    const withMail = [
      cursor,
      gmail,
      server({
        name: "managed_gateway:mail",
        displayName: "Mail",
        type: "managedGateway",
        session: { enabled: true, tools: [tool({ name: "mail", displayName: "Mail" })] },
      }),
    ];
    expect(visibleTools(cursor, withMail).map((entry) => entry.name)).toEqual(["browser_navigate"]);
  });

  it("keeps gmail tools on Cursor when no Gmail server is listed", () => {
    const cursor = server({
      name: "managed_gateway:cursor",
      displayName: "Cursor",
      type: "managedGateway",
      session: {
        enabled: true,
        tools: [
          tool({ name: "browser_navigate" }),
          tool({ name: "gmail__search", displayName: "Search Gmail" }),
        ],
      },
    });
    expect(visibleTools(cursor, [cursor]).map((entry) => entry.name)).toEqual([
      "browser_navigate",
      "gmail__search",
    ]);
  });

  it("does not hide a local filesystem tool named mail unless a mail connector exists", () => {
    const filesystem = server({
      name: "filesystem",
      session: { enabled: true, tools: [tool({ name: "mail" }), tool({ name: "read_file" })] },
    });
    expect(visibleTools(filesystem, [filesystem]).map((entry) => entry.name)).toEqual([
      "mail",
      "read_file",
    ]);
  });

  it("places local servers under Local and plugin servers under Plugin captions", () => {
    const sections = groupConnectors([
      server({ name: "filesystem", source: "local" }),
      server({ name: "acme-search", sourceLabel: "plugin: acme" }),
    ]);
    expect(sections.map((section) => section.caption)).toEqual(["Plugin: acme", "Local"]);
    expect(sections[1].groups[0].label).toBe("filesystem");
  });

  it("renders no section for an empty catalog", () => {
    expect(groupConnectors([])).toEqual([]);
  });

  it("lists a policy-blocked server with eligible 0", () => {
    const pinned = blocked("pinned");
    expect(connectorEligibleCount(pinned)).toBe(0);
    expect(connectorEnabledCount(pinned)).toBe(0);
    const sections = groupConnectors([pinned]);
    expect(sections[0].groups[0].label).toBe("pinned");
  });
});
