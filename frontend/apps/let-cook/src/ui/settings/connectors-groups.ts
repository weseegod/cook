import type { McpServerView, McpToolSummary } from "../../acp/extensions";
import { serverEnabled } from "../../acp/extensions";

export interface ConnectorServerGroup {
  /** Stable key for collapse state and test ids. */
  key: string;
  /** Display title: displayName, else stripped managed_gateway: prefix, else name. */
  label: string;
  server: McpServerView;
  /** Tools after cross-connector dedup. */
  tools: McpToolSummary[];
}

export interface ConnectorOriginSection {
  /** Quiet caption: Managed by grok.com / Plugin: X / Local. Not a toggle. */
  caption: string;
  groups: ConnectorServerGroup[];
}

/** Plugin name out of a `source_label` (`"plugin: acme"`) or a plugin-flavoured `source`. */
function pluginNameOf(server: McpServerView): string | undefined {
  for (const raw of [server.sourceLabel, server.source]) {
    const rest = raw?.startsWith("plugin:") ? raw.slice("plugin:".length).trim() : "";
    if (rest) return rest;
  }
  return undefined;
}

function isManagedGateway(server: McpServerView): boolean {
  return server.type === "managedGateway"
    || server.source === "managed"
    || server.name.startsWith("managed_gateway:");
}

/** Caption rank: Managed, then each plugin, then Local. */
function originOf(server: McpServerView): { caption: string; rank: number } {
  if (isManagedGateway(server)) {
    return { caption: "Managed by grok.com", rank: 0 };
  }
  const plugin = pluginNameOf(server);
  if (plugin) return { caption: `Plugin: ${plugin}`, rank: 1 };
  return { caption: "Local", rank: 2 };
}

/** Title a connector card: never show the raw `managed_gateway:` prefix alone. */
export function connectorDisplayLabel(server: McpServerView): string {
  if (server.displayName?.trim()) return server.displayName.trim();
  if (server.name.startsWith("managed_gateway:")) {
    return server.name.slice("managed_gateway:".length) || server.name;
  }
  return server.name;
}

function connectorIdOf(server: McpServerView): string {
  const raw = server.name.startsWith("managed_gateway:")
    ? server.name.slice("managed_gateway:".length)
    : server.name;
  return raw.toLowerCase();
}

interface OwnerIdentity {
  id: string;
  display: string;
}

/**
 * Identities of every *other* listed server, used to hide tools that belong on another card.
 * Dedup is “duplicate of another listed connector,” not a hard-coded mail strip.
 */
function otherOwners(server: McpServerView, catalog: McpServerView[]): OwnerIdentity[] {
  return catalog
    .filter((other) => other.name !== server.name)
    .map((other) => ({
      id: connectorIdOf(other),
      display: connectorDisplayLabel(other).toLowerCase(),
    }));
}

function matchesOwnerToken(value: string, owner: OwnerIdentity): boolean {
  const lower = value.toLowerCase();
  if (lower === owner.id || lower === owner.display) return true;
  // Prefix with separator: `Gmail search`, `mail.send` — not loose substring.
  for (const token of [owner.id, owner.display]) {
    if (!token) continue;
    if (lower.startsWith(`${token} `) || lower.startsWith(`${token}.`) || lower.startsWith(`${token}-`)) {
      return true;
    }
  }
  return false;
}

/**
 * Tools of server S after hiding ones owned by another listed connector.
 * Counts, mixed state, and the list all use this same filter.
 */
export function visibleTools(server: McpServerView, catalog: McpServerView[]): McpToolSummary[] {
  const tools = server.session?.tools ?? [];
  const owners = otherOwners(server, catalog);
  if (owners.length === 0) return tools;

  return tools.filter((tool) => {
    for (const owner of owners) {
      if (new RegExp(`^${escapeRegex(owner.id)}__`, "i").test(tool.name)) return false;
      if (matchesOwnerToken(tool.name, owner)) return false;
      if (tool.displayName && matchesOwnerToken(tool.displayName, owner)) return false;
    }
    return true;
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isManagedGatewayServer(server: McpServerView): boolean {
  return isManagedGateway(server);
}

/**
 * One group per server, under quiet origin captions. Empty catalog → no sections.
 */
export function groupConnectors(servers: McpServerView[]): ConnectorOriginSection[] {
  const sections = new Map<string, { rank: number; caption: string; groups: ConnectorServerGroup[] }>();

  for (const server of servers) {
    const { caption, rank } = originOf(server);
    const label = connectorDisplayLabel(server);
    const tools = visibleTools(server, servers);
    const key = isManagedGateway(server)
      ? `mcp-section:managed:${connectorIdOf(server)}`
      : pluginNameOf(server)
        ? `mcp-section:plugin:${pluginNameOf(server)}:${server.name}`
        : `mcp-section:local:${server.name}`;

    const group: ConnectorServerGroup = { key, label, server, tools };
    const current = sections.get(caption);
    if (current) current.groups.push(group);
    else sections.set(caption, { rank, caption, groups: [group] });
  }

  return [...sections.values()]
    .map((section) => ({
      caption: section.caption,
      rank: section.rank,
      groups: [...section.groups].sort((a, b) =>
        a.label.localeCompare(b.label, undefined, { sensitivity: "base" })),
    }))
    .sort((a, b) => a.rank - b.rank || a.caption.localeCompare(b.caption))
    .map(({ caption, groups }) => ({ caption, groups }));
}

/** A policy-blocked server will refuse every enable, so the header switch leaves it alone. */
function toggleable(server: McpServerView): boolean {
  return !server.session?.blockedReason;
}

/** Eligible / enabled counts for a single connector header (derived from visible tools when present). */
export function connectorEligibleCount(server: McpServerView): number {
  return toggleable(server) ? 1 : 0;
}

export function connectorEnabledCount(server: McpServerView): number {
  return toggleable(server) && serverEnabled(server) ? 1 : 0;
}

/** Visible tools that read enabled — drives mixed state on the connector header when useful. */
export function connectorToolEnabledCount(tools: McpToolSummary[]): number {
  return tools.filter((tool) => tool.enabled !== false).length;
}
