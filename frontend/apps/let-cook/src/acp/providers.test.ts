import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCatalogStore } from "../state/catalog";
import { upsertModel } from "./providers";

vi.mock("./host", () => ({
  desktopCommand: vi.fn(async () => ({ ok: true, modelId: "grok-custom" })),
  isTauriRuntime: vi.fn(() => true),
  request: vi.fn(async () => ({ ok: true })),
}));

describe("model settings and composer catalog", () => {
  beforeEach(() => {
    useCatalogStore.getState().setModelCatalog({
      currentModelId: "grok-4.5",
      models: [{ id: "grok-4.5", name: "Grok 4.5", provider: "xai" }],
    });
  });

  it("shows a saved model before the agent refreshes its catalog", async () => {
    await upsertModel({
      id: "grok-custom",
      providerId: "xai",
      name: "Grok Custom",
      input: ["text"],
      contextWindow: 256_000,
      maxCompletionTokens: 64_000,
      supportsReasoningEffort: true,
    });

    expect(useCatalogStore.getState().models).toContainEqual(expect.objectContaining({
      id: "grok-custom",
      name: "Grok Custom",
      provider: "xai",
      contextWindow: 256_000,
      configured: true,
    }));
    expect(useCatalogStore.getState().currentModelId).toBe("grok-4.5");

    await upsertModel({
      id: "grok-custom",
      providerId: "xai",
      name: "Grok Renamed",
      input: ["text", "image"],
      contextWindow: 300_000,
    });
    expect(useCatalogStore.getState().models.filter((model) => model.id === "grok-custom")).toEqual([
      expect.objectContaining({ name: "Grok Renamed", inputModalities: ["text", "image"], contextWindow: 300_000 }),
    ]);
  });
});
