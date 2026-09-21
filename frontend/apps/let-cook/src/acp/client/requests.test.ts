import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../host", () => ({
  notify: vi.fn(async () => undefined),
  request: vi.fn(async () => ({})),
  respond: vi.fn(async () => undefined),
}));

import { request } from "../host";
import { sendModelChoice } from "./requests";
import { useCatalogStore } from "../../state/catalog";
import { useSessionStore } from "../../state/session";

describe("sendModelChoice", () => {
  beforeEach(() => {
    vi.mocked(request).mockResolvedValue({});
    useSessionStore.getState().resetConversation("session-1");
    useSessionStore.setState({ modelId: "grok-4.5", usage: { used: 42_000, size: 300_000 } });
    useCatalogStore.setState({
      currentModelId: "grok-4.5",
      models: [
        { id: "grok-4.5", provider: "xai", contextWindow: 300_000 },
        { id: "gpt-5", provider: "openai", contextWindow: 1_000_000 },
      ],
    });
  });

  it("updates the context denominator immediately and sends the session switch", async () => {
    await sendModelChoice("gpt-5");

    expect(useSessionStore.getState().modelId).toBe("gpt-5");
    expect(useSessionStore.getState().usage).toEqual({ used: 42_000, size: 1_000_000 });
    expect(request).toHaveBeenCalledWith("session/set_model", { sessionId: "session-1", modelId: "gpt-5" });
  });
});
