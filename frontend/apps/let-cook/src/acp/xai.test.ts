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
    expect(merged.models.map((model) => model.id)).toEqual(["gpt-5"]);
  });

  it("offers only saved Grok models while retaining catalog metadata", () => {
    const catalog = modelCatalog({
      currentModelId: "grok-4.7",
      availableModels: [
        { id: "grok-4.5", name: "Grok 4.5", provider: "xai" },
        { id: "grok-4.6", name: "Grok 4.6", provider: "xai", _meta: { totalContextTokens: 500_000 } },
        { id: "grok-4.7", name: "Grok 4.7", provider: "xai" },
        { id: "grok-4.8", name: "Grok 4.8", provider: "xai" },
      ],
    });
    const configured = {
      providers: [],
      models: [
        { id: "grok-4.6", provider: "xai", input: ["text"] },
        { id: "grok-custom", provider: "xai", name: "Grok Custom", input: ["text"] },
      ],
    };

    const merged = mergeConfiguredModels(catalog, configured);
    expect(merged.models.map((model) => model.id)).toEqual(["grok-4.6", "grok-custom"]);
    expect(merged.models[0]).toMatchObject({ name: "Grok 4.6", contextWindow: 500_000, configured: true });
    expect(merged.currentModelId).toBe("grok-4.7");
    expect(mergeConfiguredModels(catalog, { providers: [], models: [] }).models).toEqual([]);
    expect(mergeConfiguredModels(catalog, null).models).toHaveLength(4);
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
