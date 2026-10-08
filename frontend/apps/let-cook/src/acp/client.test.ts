import { describe, expect, it } from "vitest";
import { useSessionStore } from "../state/session";
import { CookAcpClient } from "./client";

/** The client's frame-coalesced update queue, which `clearTranscript` has to drain first. */
function coalescer(client: CookAcpClient) {
  return (client as unknown as {
    sessionUpdates: { enqueue: (notification: never) => void; flushNow: () => void };
  }).sessionUpdates;
}

describe("CookAcpClient.clearTranscript", () => {
  it("applies a queued frame before wiping, so it cannot repaint the cleared text", () => {
    const scheduled: Array<() => void> = [];
    const client = new CookAcpClient({ scheduleFlush: (flush) => scheduled.push(flush) });
    useSessionStore.getState().resetConversation("sess-queued");

    // A live `session/update` is still sitting in the frame queue when the user clears.
    coalescer(client).enqueue({
      sessionId: "sess-queued",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late text" } },
    } as never);
    expect(useSessionStore.getState().blocks).toEqual([]);

    client.clearTranscript();
    expect(useSessionStore.getState().blocks).toEqual([]);

    // The frame the coalescer had already scheduled runs afterwards and finds nothing pending.
    for (const flush of scheduled.splice(0)) flush();
    expect(useSessionStore.getState().blocks).toEqual([]);
  });
});
