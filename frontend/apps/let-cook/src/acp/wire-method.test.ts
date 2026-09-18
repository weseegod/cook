import { beforeEach, describe, expect, it } from "vitest";
import { wireMethod } from "./host";
import { mockRequests, mockRequest, mockReset } from "./mock-transport";

/**
 * The agent answers a bare `x.ai/...` request with `-32601 Method not found`; extension calls only
 * reach its ext handler as `_x.ai/...`. A regression here is invisible in the UI — the model
 * picker, session list, and settings surfaces just come up empty — so it is pinned here.
 */
describe("extension method wire form", () => {
  beforeEach(() => mockReset({ authMethodId: "cached_token" }));

  it("prefixes extension methods and leaves standard ACP methods untouched", () => {
    expect(wireMethod("x.ai/models/list")).toBe("_x.ai/models/list");
    expect(wireMethod("x.ai/providers/upsert")).toBe("_x.ai/providers/upsert");
    expect(wireMethod("x.ai/session/list")).toBe("_x.ai/session/list");
    expect(wireMethod("session/new")).toBe("session/new");
    expect(wireMethod("session/prompt")).toBe("session/prompt");
    expect(wireMethod("initialize")).toBe("initialize");
  });

  it("routes a prefixed extension call under its logical method name", async () => {
    const models = await mockRequest<{ result: { availableModels: unknown[] } }>("_x.ai/models/list", {});
    expect(models.result.availableModels.length).toBeGreaterThan(0);
    expect(mockRequests().map((request) => request.method)).toContain("x.ai/models/list");
  });

  it("rejects an unprefixed extension call the way the agent does", async () => {
    await expect(mockRequest("x.ai/models/list", {})).rejects.toThrow(/Method not found/);
    expect(mockRequests()).toEqual([]);
  });
});
