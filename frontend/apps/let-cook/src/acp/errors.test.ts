import { describe, expect, it } from "vitest";
import { normalizeError } from "./errors";

describe("normalizeError", () => {
  it("redacts credentials before they reach a user-facing error", () => {
    expect(normalizeError("api_key=sk-live-secret-value")).toBe("[redacted]");
    expect(normalizeError(new Error("Bearer super-secret-token"))).toBe("Bearer [redacted]");
  });

  it("unwraps structured transport errors and removes stack noise", () => {
    expect(normalizeError({ error: { message: "provider failed" } })).toBe("provider failed");
    expect(normalizeError("Error: failed\n    at request (host.ts:1:2)")).toBe("failed");
  });

  it("uses a stable fallback for empty or null errors", () => {
    expect(normalizeError(null, "Fallback")).toBe("Fallback");
    expect(normalizeError({}, "Fallback")).toBe("Fallback");
  });
});
