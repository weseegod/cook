import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeRewind, listRewindPoints, sessionRecap } from "./session-ops";
import { mockRequest, mockRequests, mockReset, subscribe } from "./mock-transport";

describe("session-ops rewind + recap", () => {
  beforeEach(() => {
    mockReset({
      cancelRewind: true,
      sessionRecap: true,
      rewindPoints: [
        {
          promptIndex: 0,
          createdAt: "2026-09-18T08:00:00Z",
          numFileSnapshots: 0,
          promptPreview: "First prompt",
        },
        {
          promptIndex: 2,
          createdAt: "2026-09-18T08:10:00Z",
          numFileSnapshots: 1,
          hasFileChanges: true,
          promptPreview: "Third prompt",
        },
      ],
      recapSummary: "We fixed the flaky queue worker.",
    });
  });

  it("lists rewind points from the mock agent", async () => {
    const points = await listRewindPoints("mock-session");
    expect(points).toEqual([
      {
        promptIndex: 0,
        createdAt: "2026-09-18T08:00:00Z",
        numFileSnapshots: 0,
        hasFileChanges: false,
        promptPreview: "First prompt",
      },
      {
        promptIndex: 2,
        createdAt: "2026-09-18T08:10:00Z",
        numFileSnapshots: 1,
        hasFileChanges: true,
        promptPreview: "Third prompt",
      },
    ]);
    expect(mockRequests().map((request) => request.method)).toContain("x.ai/rewind/points");
    expect(mockRequests().find((request) => request.method === "x.ai/rewind/points")?.params).toEqual({
      sessionId: "mock-session",
    });
  });

  it("executes rewind and lets the caller reload the session", async () => {
    const result = await executeRewind({
      sessionId: "mock-session",
      targetPromptIndex: 2,
      force: true,
    });
    expect(result.success).toBe(true);
    expect(result.targetPromptIndex).toBe(2);

    // After execute, Desktop replays via session/load — assert the mock accepts it.
    await mockRequest("session/load", { sessionId: "mock-session", cwd: "/tmp/cook-demo", mcpServers: [] });
    const methods = mockRequests().map((request) => request.method);
    expect(methods).toContain("x.ai/rewind/execute");
    expect(methods).toContain("session/load");
    expect(mockRequests().find((request) => request.method === "x.ai/rewind/execute")?.params).toMatchObject({
      sessionId: "mock-session",
      targetPromptIndex: 2,
      force: true,
    });
  });

  it("fires recap and emits a session_recap notification", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const dispose = subscribe((message) => {
      const envelope = message as { method?: string; params?: { update?: Record<string, unknown> } };
      if (envelope.method === "_x.ai/session_notification" && envelope.params?.update) {
        updates.push(envelope.params.update);
      }
    });
    const ack = await sessionRecap({ sessionId: "mock-session", auto: false });
    expect(ack).toEqual({ ok: true, disabled: undefined });
    await vi.waitFor(() => {
      expect(updates.some((update) => update.sessionUpdate === "session_recap")).toBe(true);
    });
    expect(updates.find((update) => update.sessionUpdate === "session_recap")).toMatchObject({
      summary: "We fixed the flaky queue worker.",
      auto: false,
    });
    dispose();
  });

  it("reports disabled when sessionRecap is off", async () => {
    mockReset({ sessionRecap: false });
    await expect(sessionRecap({ sessionId: "mock-session" })).resolves.toEqual({
      ok: true,
      disabled: true,
    });
  });
});
