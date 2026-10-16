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

  it("drops a replay the Clear watermark already wiped, and keeps what came after", () => {
    const dedupe = new SessionEventDedupe();
    const live = (sequence: number) => ({ sessionId: "s1", _meta: { eventId: `s1-${sequence}` } });
    expect(dedupe.accept("acp", live(1))).toBe(true);
    expect(dedupe.accept("acp", live(5))).toBe(true);

    dedupe.markCleared("s1");

    // Whatever a load replays below the wipe stays gone; a live id never suppresses a replay, so
    // the watermark is the only thing holding the cleared rows back.
    expect(dedupe.accept("acp", { sessionId: "s1", _meta: { isReplay: true, eventId: "s1-1" } })).toBe(false);
    expect(dedupe.accept("acp", { sessionId: "s1", _meta: { isReplay: true, eventId: "s1-5" } })).toBe(false);
    expect(dedupe.accept("acp", { sessionId: "s1", _meta: { isReplay: true, eventId: "s1-6" } })).toBe(true);

    // The wipe belongs to the conversation the window cleared.
    expect(dedupe.accept("acp", { sessionId: "s2", _meta: { isReplay: true, eventId: "s2-1" } })).toBe(true);
    // Live events keep their own ordering, cleared or not.
    expect(dedupe.accept("acp", live(5))).toBe(false);
    expect(dedupe.accept("acp", live(6))).toBe(true);
  });

  it("counts a replayed event towards a later clear", () => {
    const dedupe = new SessionEventDedupe();
    const replayed = { sessionId: "s1", _meta: { isReplay: true, eventId: "s1-4" } };
    expect(dedupe.accept("acp", replayed)).toBe(true);

    dedupe.markCleared("s1");

    expect(dedupe.accept("acp", replayed)).toBe(false);
  });

  it("keeps a replay from suppressing a live update under the same sequence", () => {
    const dedupe = new SessionEventDedupe();
    // An agent restart replays ids its fresh process then reuses for live updates.
    expect(dedupe.accept("acp", { sessionId: "s1", _meta: { isReplay: true, eventId: "s1-9" } })).toBe(true);
    expect(dedupe.accept("acp", { sessionId: "s1", _meta: { eventId: "s1-9" } })).toBe(true);
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
