import { describe, expect, it } from "vitest";
import { sanitizeNotifyText, shouldNotifyTurnComplete, turnCompleteNotifyCopy } from "./os-notify";

describe("os-notify", () => {
  it("never puts credentials in sanitized bodies", () => {
    expect(sanitizeNotifyText("api_key=sk-secret-value here")).toContain("[redacted]");
    expect(sanitizeNotifyText("Bearer token=abc123xyz")).toContain("[redacted]");
    expect(sanitizeNotifyText("token=abc123xyz")).toContain("[redacted]");
    expect(sanitizeNotifyText("sk-abcdefghijklmnop")).toBe("[redacted]");
  });

  it("maps outcomes to credential-free copy", () => {
    expect(turnCompleteNotifyCopy({ kind: "completed" })).toEqual({
      title: "Let Cook",
      body: "Turn completed",
    });
    expect(turnCompleteNotifyCopy({ kind: "cancelled" })).toEqual({
      title: "Let Cook",
      body: "Turn cancelled",
    });
    expect(turnCompleteNotifyCopy({ kind: "failed", error: "api_key=secret" })).toEqual({
      title: "Let Cook",
      body: "Turn failed",
    });
  });

  it("detects an unfocused document", () => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    expect(shouldNotifyTurnComplete()).toBe(true);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });
});
