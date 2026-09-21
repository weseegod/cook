import { describe, expect, it } from "vitest";
import { mergeConfiguredModels, modelCatalog, providerDisplayName, reasoningEffortOptions } from "./xai";

describe("model catalog normalization", () => {
  it("normalizes reasoning metadata and exposes fallback levels", () => {
    const catalog = modelCatalog({
      availableModels: [
        {
          id: "o4-mini",
          _meta: {
            supportsReasoningEffort: true,
            reasoningEffort: "medium",
            reasoningEfforts: [{ id: "balanced", value: "medium", label: "Balanced" }, "low"],
          },
        },
        { id: "gpt-5", _meta: { supportsReasoningEffort: true } },
        { id: "gpt-4.1", _meta: { reasoningEfforts: ["high"] } },
      ],
    });

    expect(catalog.models[0]).toMatchObject({
      supportsReasoningEffort: true,
      reasoningEffort: "medium",
      reasoningEfforts: [
        { id: "balanced", value: "medium", label: "Balanced" },
        { id: "low", value: "low", label: "Low" },
      ],
    });
    expect(reasoningEffortOptions(catalog.models[1]).map((option) => option.value)).toEqual(["xhigh", "high", "medium", "low"]);
    expect(reasoningEffortOptions(catalog.models[2])).toEqual([]);
  });

  it("uses configured provider ownership for unnamespaced OpenAI models", () => {
    const catalog = modelCatalog({
      currentModelId: "gpt-5",
      availableModels: [
        { id: "gpt-5", name: "GPT-5", _meta: { totalContextTokens: 272_000 } },
        { id: "grok-4.5", name: "Grok 4.5", provider: "xai" },
      ],
    });

    const merged = mergeConfiguredModels(catalog, {
      providers: [],
      models: [{ id: "gpt-5", model: "gpt-5", name: "GPT-5", provider: "openai", input: ["text", "image"], contextWindow: 1_000_000 }],
      defaultModel: "gpt-5",
    });

    expect(merged.models.find((model) => model.id === "gpt-5")).toMatchObject({
      provider: "openai",
      contextWindow: 1_000_000,
      configured: true,
    });
    expect(merged.models.find((model) => model.id === "grok-4.5")?.provider).toBe("xai");
  });

  it("keeps configured models selectable when the ACP catalog omits them", () => {
    const merged = mergeConfiguredModels(modelCatalog({ availableModels: [] }), {
      providers: [],
      models: [{ id: "o4-mini", model: "o4-mini", provider: "openai", input: ["text"] }],
      defaultModel: "o4-mini",
    });

    expect(merged.currentModelId).toBe("o4-mini");
    expect(merged.models).toContainEqual(expect.objectContaining({ id: "o4-mini", provider: "openai" }));
  });

  it("renders provider ids with the Settings catalog labels", () => {
    expect(providerDisplayName("openai")).toBe("OpenAI");
    expect(providerDisplayName("xai")).toBe("xAI");
    expect(providerDisplayName("custom-provider")).toBe("custom-provider");
  });
});
