import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "../state/session";
import { CookAcpClient } from "./client";
import { notify, onLog, onMessages, onStatus, request, startProcess, stopProcess } from "./host";

/**
 * The host is the process boundary: these tests assert which side of it the client reaches for,
 * so every command the client can send is recorded rather than executed.
 */
vi.mock("./host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./host")>();
  return {
    ...actual,
    notify: vi.fn(async () => undefined),
    request: vi.fn(async () => ({})),
    startProcess: vi.fn(async (cwd: string) => ({ binaryPath: "test", binaryVersion: "0", cwd })),
    stopProcess: vi.fn(async () => undefined),
    onMessages: vi.fn(async () => () => undefined),
    onStatus: vi.fn(async () => () => undefined),
    onLog: vi.fn(async () => () => undefined),
  };
});

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

describe("CookAcpClient.switchWorkspace", () => {
  /** Only the shapes the client actually parses; every other method answers an empty envelope. */
  async function hostReply(method: string) {
    if (method === "session/new") return { sessionId: "sess-new" };
    if (method === "x.ai/providers/list") return { providers: [] };
    return {};
  }

  /** A window on a live agent, with one conversation mid-turn. */
  function runningWindow(cwd = "/old") {
    useSessionStore.setState({
      connection: "ready",
      cwd,
      sessionId: "sess-old",
      turnRunning: true,
      error: null,
      workingSessions: { "sess-old": { startedAt: 1_000, activity: null, promptIds: ["p1"] } },
    });
    const client = new CookAcpClient();
    (client as unknown as { cwd: string | null }).cwd = cwd;
    return client;
  }

  beforeEach(() => {
    vi.mocked(notify).mockClear();
    vi.mocked(request).mockReset();
    vi.mocked(request).mockImplementation(async (method: string) => hostReply(method) as never);
    vi.mocked(startProcess).mockClear();
    vi.mocked(stopProcess).mockClear();
  });

  it("opens the folder as a new conversation and leaves the running one alone", async () => {
    const client = runningWindow();

    await client.switchWorkspace("/new");

    const created = vi.mocked(request).mock.calls.find(([method]) => method === "session/new");
    expect(created?.[1]).toMatchObject({ cwd: "/new" });
    // Same process, same turn: nothing here may reach for the process lifecycle or a cancel.
    expect(vi.mocked(stopProcess)).not.toHaveBeenCalled();
    expect(vi.mocked(startProcess)).not.toHaveBeenCalled();
    expect(vi.mocked(notify).mock.calls.filter(([method]) => method === "session/cancel")).toEqual([]);
    expect(useSessionStore.getState()).toMatchObject({
      sessionId: "sess-new",
      cwd: "/new",
      connection: "ready",
      error: null,
    });
    // The conversation that was running keeps its in-flight turn registered for the list row.
    expect(useSessionStore.getState().workingSessions["sess-old"]?.promptIds).toEqual(["p1"]);
  });

  it("falls back to the process path when no agent is live", async () => {
    useSessionStore.setState({ connection: "idle", cwd: null, sessionId: null, turnRunning: false, workingSessions: {} });
    const client = new CookAcpClient();

    await client.switchWorkspace("/new");

    expect(vi.mocked(stopProcess)).toHaveBeenCalled();
    expect(vi.mocked(startProcess)).toHaveBeenCalledWith("/new");
    expect(useSessionStore.getState().cwd).toBe("/new");
  });
});
