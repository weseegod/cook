import { describe, expect, it, vi } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { SessionNotificationCoalescer } from "./client-coalesce";

function notification(index: number): SessionNotification {
  return {
    sessionId: "session",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: String(index) },
    },
  } as SessionNotification;
}

describe("SessionNotificationCoalescer", () => {
  it("applies ten chunks as one ordered store commit per frame", () => {
    const apply = vi.fn();
    let flushFrame: (() => void) | undefined;
    const coalescer = new SessionNotificationCoalescer(apply, (flush) => {
      flushFrame = flush;
    });

    for (let index = 0; index < 10; index += 1) coalescer.enqueue(notification(index));

    expect(apply).not.toHaveBeenCalled();
    flushFrame?.();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0]).toHaveLength(10);
    expect((apply.mock.calls[0][0] as SessionNotification[]).map((item) => (item.update as { content: { text: string } }).content.text)).toEqual(
      Array.from({ length: 10 }, (_, index) => String(index)),
    );
  });

  it("flushes immediately when an ordering boundary is reached", () => {
    const apply = vi.fn();
    const coalescer = new SessionNotificationCoalescer(apply, () => undefined);
    coalescer.enqueue(notification(1));
    coalescer.flushNow();
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
