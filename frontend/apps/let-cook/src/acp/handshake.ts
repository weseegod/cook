import { PROTOCOL_VERSION, type InitializeRequest } from "@agentclientprotocol/sdk";

/**
 * Single source of truth for what Desktop advertises on `initialize`.
 *
 * A cap is `true` only when the matching host or reverse handler exists
 * (`docs/desktop-app.md` §4.2). Map rows: H-term, H-mcp, ACP-t-*, §1.1 mcpApps.
 */
export const CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
  /** H-term — no real PTY yet; do not stub while this is false. */
  terminal: false,
  plan: {},
  folderTrustInteractive: true,
  /** Live user-message echoes let queued turns appear in the Desktop transcript. */
  userMessageEcho: true,
  /** H-mcp — do not advertise until R-sdk exists. */
  mcpApps: false,
  clientIdentifier: "grok-desktop" as const,
  clientType: "grok_desktop" as const,
  bufferingSettings: { minDelayMs: 16, maxDelayMs: 64, maxBytes: 65536 },
} as const;

/** Reverse methods the client currently parks a UI card for (Layer 2 seeds). */
export const IMPLEMENTED_REVERSE_METHODS = [
  "session/request_permission",
  "x.ai/ask_user_question",
  "x.ai/exit_plan_mode",
  "x.ai/mcp/elicit",
  "x.ai/folder_trust/request",
] as const;

/**
 * Methods that would warrant `-32601` if advertised-required but unanswered.
 * Empty while terminal/mcpApps/hooks stay off (`docs/desktop-app.md` §5.5).
 */
export const ADVERTISED_REQUIRED_METHODS: readonly string[] = [];

/** Advertised capability keys that must have a matching handler (honesty test). */
export function advertisedHandlerKeys(): string[] {
  const keys: string[] = [];
  if (CAPABILITIES.fs.readTextFile) keys.push("fs/read_text_file");
  if (CAPABILITIES.fs.writeTextFile) keys.push("fs/write_text_file");
  if (CAPABILITIES.terminal) keys.push("terminal/*");
  if (CAPABILITIES.plan) keys.push("plan");
  if (CAPABILITIES.folderTrustInteractive) keys.push("x.ai/folder_trust/request");
  if (CAPABILITIES.mcpApps) keys.push("x.ai/mcp/sdk_call");
  return keys;
}

export function buildInitializeRequest(version: string): InitializeRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: {
        readTextFile: CAPABILITIES.fs.readTextFile,
        writeTextFile: CAPABILITIES.fs.writeTextFile,
      },
      terminal: CAPABILITIES.terminal,
      plan: CAPABILITIES.plan,
      _meta: {
        "x.ai/folderTrust": { interactive: CAPABILITIES.folderTrustInteractive },
        "x.ai/userMessageEcho": CAPABILITIES.userMessageEcho,
      },
    },
    clientInfo: { name: "Let Cook", title: "Let Cook", version },
    _meta: {
      clientIdentifier: CAPABILITIES.clientIdentifier,
      clientType: CAPABILITIES.clientType,
      mcpApps: CAPABILITIES.mcpApps,
      bufferingSettings: { ...CAPABILITIES.bufferingSettings },
    },
  };
}
