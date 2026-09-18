import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./host", () => ({
  notify: vi.fn(async () => undefined),
  request: vi.fn(async (method: string, params: unknown) => {
    if (method === "x.ai/btw") return { answer: `echo:${(params as { question: string }).question}` };
    if (method === "x.ai/interject") return { status: "queued" };
    return {};
  }),
}));

import { notify, request } from "./host";
import {
  askBtw,
  claimSelfInterjection,
  clearQueuedPrompts,
  interjectPrompt,
  rememberSelfInterjection,
  removeQueuedPrompt,
} from "./turn-ops";

describe("turn-ops (P9)", () => {
  beforeEach(() => {
    vi.mocked(notify).mockClear();
    vi.mocked(request).mockClear();
  });

  it("askBtw requests x.ai/btw", async () => {
    const result = await askBtw("s1", "what next?");
    expect(request).toHaveBeenCalledWith("x.ai/btw", { sessionId: "s1", question: "what next?" });
    expect(result).toEqual({ answer: "echo:what next?" });
  });

  it("interjectPrompt requests x.ai/interject with a minted id", async () => {
    await interjectPrompt("s1", "steer");
    expect(request).toHaveBeenCalledWith(
      "x.ai/interject",
      expect.objectContaining({ sessionId: "s1", text: "steer", interjectionId: expect.stringMatching(/^inj-/) }),
    );
  });

  it("queue remove/clear are notifications", async () => {
    await removeQueuedPrompt("s1", "p1", 3);
    await clearQueuedPrompts("s1");
    expect(notify).toHaveBeenCalledWith("x.ai/queue/remove", {
      sessionId: "s1",
      id: "p1",
      expectedVersion: 3,
      owner: "grok-desktop",
    });
    expect(notify).toHaveBeenCalledWith("x.ai/queue/clear", {
      sessionId: "s1",
      clientIdentifier: "grok-desktop",
    });
  });

  it("claimSelfInterjection drops matching broadcast ids", () => {
    rememberSelfInterjection("inj-1");
    expect(claimSelfInterjection("inj-1")).toBe(true);
    expect(claimSelfInterjection("inj-1")).toBe(false);
  });
});
