import { describe, expect, it } from "vitest";
import {
  ADVERTISED_REQUIRED_METHODS,
  CAPABILITIES,
  IMPLEMENTED_REVERSE_METHODS,
  advertisedHandlerKeys,
  buildInitializeRequest,
} from "./handshake";

describe("CAPABILITIES honesty (C1)", () => {
  it("advertises terminal false and mcpApps false", () => {
    expect(CAPABILITIES.terminal).toBe(false);
    expect(CAPABILITIES.mcpApps).toBe(false);
  });

  it("keeps fs + plan + folder-trust interactive", () => {
    expect(CAPABILITIES.fs.readTextFile).toBe(true);
    expect(CAPABILITIES.fs.writeTextFile).toBe(true);
    expect(CAPABILITIES.plan).toEqual({});
    expect(CAPABILITIES.folderTrustInteractive).toBe(true);
  });

  it("keeps clientIdentifier grok-desktop verbatim", () => {
    expect(CAPABILITIES.clientIdentifier).toBe("grok-desktop");
    const params = buildInitializeRequest("1.0.0");
    expect(params._meta?.clientIdentifier).toBe("grok-desktop");
    expect(params.clientCapabilities?.terminal).toBe(false);
    expect((params._meta as { mcpApps?: boolean })?.mcpApps).toBe(false);
  });

  it("advertised keys ⊆ implemented handlers", () => {
    const advertised = advertisedHandlerKeys();
    expect(advertised).not.toContain("terminal/*");
    expect(advertised).not.toContain("x.ai/mcp/sdk_call");
    expect(advertised).toEqual(
      expect.arrayContaining(["fs/read_text_file", "fs/write_text_file", "plan", "x.ai/folder_trust/request"]),
    );
    for (const key of advertised) {
      if (key === "fs/read_text_file" || key === "fs/write_text_file" || key === "plan") continue;
      expect(IMPLEMENTED_REVERSE_METHODS as readonly string[]).toContain(key);
    }
    expect(ADVERTISED_REQUIRED_METHODS).toEqual([]);
  });
});
