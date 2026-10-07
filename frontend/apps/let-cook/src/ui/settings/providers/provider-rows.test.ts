import { describe, expect, it } from "vitest";
import { findPreset } from "../../../acp/provider-presets";
import type { ProviderSummary } from "../../../acp/providers";
import { buildProviderRows } from "./provider-rows";

const openai = findPreset("openai")!;
const anthropic = findPreset("anthropic")!;
const xai = findPreset("xai")!;

function summary(id: string, extra: Partial<ProviderSummary> = {}): ProviderSummary {
  return {
    id,
    hasKey: true,
    inlineKey: true,
    envKeyPresent: false,
    extraHeaders: {},
    models: [],
    ...extra,
  };
}

describe("provider row order", () => {
  it("puts a removed built-in last and ignores catalog models and oauth", () => {
    const rows = buildProviderRows({
      presets: [openai, anthropic, xai],
      providers: [summary("openai", { name: "OpenAI" }), summary("opencode", { name: "OpenCode", baseUrl: "http://127.0.0.1:4096/v1" })],
      explicitModels: [{ id: "grok-4.5", provider: "xai", name: "Grok 4.5" }],
      catalog: [{ id: "grok-4.5", name: "Grok 4.5", provider: "xai" }],
      selectedModel: "gpt-5",
      hiddenIds: ["xai"],
      xaiAuthenticated: true,
      xaiEmail: "cook@example.com",
    });
    expect(rows.map((row) => row.preset.id)).toEqual(["openai", "opencode", "anthropic", "xai"]);
    const removed = rows.at(-1)!;
    expect(removed.inactive).toBe(true);
    expect(removed.oauthConnected).toBe(false);
    expect(removed.provider).toBeUndefined();
    expect(removed.models).toEqual([]);
  });

  it("keeps an active signed-out xAI card on Connect, not inactive", () => {
    const rows = buildProviderRows({
      presets: [openai, xai],
      providers: [],
      explicitModels: [],
      catalog: [],
      selectedModel: "",
      hiddenIds: [],
      xaiAuthenticated: false,
    });
    const card = rows.find((row) => row.preset.id === "xai")!;
    expect(card.inactive).toBe(false);
    expect(card.oauthConnected).toBe(false);
    expect(rows.map((row) => row.preset.id)).toEqual(["openai", "xai"]);
  });
});
