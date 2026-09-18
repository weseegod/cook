import { describe, expect, it } from "vitest";
import { suggestedLimits, SUGGESTED_CONTEXT, SUGGESTED_OUTPUT } from "./model-dialog";

describe("suggestedLimits", () => {
  it("starts from the panel's baseline when the listing has no numbers", () => {
    expect(suggestedLimits()).toEqual({ contextWindow: SUGGESTED_CONTEXT, maxCompletionTokens: SUGGESTED_OUTPUT });
    expect(suggestedLimits({})).toEqual({ contextWindow: SUGGESTED_CONTEXT, maxCompletionTokens: SUGGESTED_OUTPUT });
  });

  it("never suggests more context than the model declares", () => {
    expect(suggestedLimits({ contextWindow: 262_144 }).contextWindow).toBe(262_144);
    expect(suggestedLimits({ contextWindow: 400_000 }).contextWindow).toBe(SUGGESTED_CONTEXT);
  });

  it("takes the model's own output ceiling, which may exceed the baseline", () => {
    expect(suggestedLimits({ maxCompletionTokens: 131_072 }).maxCompletionTokens).toBe(131_072);
    expect(suggestedLimits({ maxCompletionTokens: 8_192 }).maxCompletionTokens).toBe(8_192);
  });
});
