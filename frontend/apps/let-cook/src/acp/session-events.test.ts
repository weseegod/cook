import { describe, expect, it } from "vitest";
import { PromptCorrelation, SessionEventDedupe, eventSequence } from "./session-events";

describe("session event routing", () => {
  it("extracts the TUI event sequence from eventId", () => {
    expect(eventSequence({ eventId: "session-abc-42" })).toBe(42);
    expect(eventSequence({ eventSeq: 7 })).toBe(7);
    expect(eventSequence({ eventId: "not-sequenced" })).toBe(null);
  });

  it("drops duplicates per session and per notification rail", () => {
    const dedupe = new SessionEventDedupe();
    const update = { sessionId: "s1", _meta: { eventId: "s1-4" } };
    expect(dedupe.accept("acp", update)).toBe(true);
    expect(dedupe.accept("acp", update)).toBe(false);
    expect(dedupe.accept("acp", { ...update, _meta: { eventId: "s1-3" } })).toBe(false);
    expect(dedupe.accept("xai", update)).toBe(true);
    expect(dedupe.accept("acp", { ...update, _meta: { isReplay: true, eventId: "s1-2" } })).toBe(true);
  });

  it("keeps queued prompts isolated from stale live updates", () => {
    const prompts = new PromptCorrelation();
    prompts.begin("p1");
    prompts.begin("p2");
    expect(prompts.accept({ _meta: { promptId: "p1" } })).toBe(true);
    expect(prompts.accept({ promptId: "p2" })).toBe(true);
    expect(prompts.accept({ _meta: { promptId: "old" } })).toBe(false);
    expect(prompts.accept({ _meta: { isReplay: true, promptId: "old" } })).toBe(true);
    prompts.end("p1");
    expect(prompts.accept({ _meta: { promptId: "p1" } })).toBe(false);
    expect(prompts.accept({ _meta: { promptId: "p2" } })).toBe(true);
    prompts.end("p2");
    // With no live turn, extension events without a current client prompt remain backwards-compatible.
    expect(prompts.accept({ _meta: { promptId: "server-originated" } })).toBe(true);
  });
});
