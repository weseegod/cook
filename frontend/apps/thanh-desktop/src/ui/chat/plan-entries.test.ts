import { describe, expect, it } from "vitest";
import { planEntryStatus, planEntryText } from "./plan-entries";

describe("plan entries", () => {
  it("reads text from an ACP entry and from looser shapes", () => {
    expect(planEntryText({ content: "Map the goal surface", priority: "high", status: "pending" })).toBe("Map the goal surface");
    expect(planEntryText("plain body line")).toBe("plain body line");
    expect(planEntryText({ title: "Titled" })).toBe("Titled");
    expect(planEntryText(null)).toBe("");
  });

  it("maps ACP statuses and treats an unknown one as pending", () => {
    expect(planEntryStatus({ content: "a", status: "pending" })).toBe("pending");
    expect(planEntryStatus({ content: "b", status: "in_progress" })).toBe("in_progress");
    expect(planEntryStatus({ content: "c", status: "completed" })).toBe("completed");
    expect(planEntryStatus({ content: "d", status: "in-progress" })).toBe("in_progress");
    expect(planEntryStatus({ content: "e" })).toBe("pending");
    expect(planEntryStatus("a bare line")).toBe("pending");
  });

  it("detects the cancelled flag ACP smuggles through `_meta`", () => {
    // ACP has no cancelled status: the agent sends `completed` plus `_meta.cancelled`.
    expect(planEntryStatus({ content: "dropped", status: "completed", _meta: { cancelled: true } })).toBe("cancelled");
    expect(planEntryStatus({ content: "dropped", status: "completed", meta: { cancelled: true } })).toBe("cancelled");
    expect(planEntryStatus({ content: "done", status: "completed", _meta: { cancelled: false } })).toBe("completed");
  });
});
