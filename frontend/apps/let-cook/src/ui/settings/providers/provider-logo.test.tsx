import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { isOauthProvider, oauthProviderName, providerLogoSrc, ProviderLogo } from "./provider-logo";

describe("provider logos", () => {
  it("maps the three OAuth cards to ChatGPT, Claude and Grok", () => {
    expect(isOauthProvider("openai")).toBe(true);
    expect(isOauthProvider("anthropic")).toBe(true);
    expect(isOauthProvider("xai")).toBe(true);
    expect(isOauthProvider("deepseek")).toBe(false);
    expect(oauthProviderName("openai")).toBe("ChatGPT");
    expect(oauthProviderName("anthropic")).toBe("Claude");
    expect(oauthProviderName("xai")).toBe("Grok");
  });

  it("points known providers at public/providers SVGs and keeps display classes", () => {
    expect(providerLogoSrc("openai")).toBe("/providers/openai.svg");
    expect(providerLogoSrc("anthropic")).toBe("/providers/anthropic.svg");
    expect(providerLogoSrc("xai")).toBe("/providers/xai.svg");
    expect(providerLogoSrc("deepseek")).toBe("/providers/deepseek.svg");
    expect(providerLogoSrc("openrouter")).toBe("/providers/openrouter.svg");
    expect(providerLogoSrc("xiaomi")).toBe("/providers/xiaomi.svg");
    expect(providerLogoSrc("zai")).toBeNull();

    const cases: Array<[string, string, string]> = [
      ["openai", ".provider-logo-openai", "/providers/openai.svg"],
      ["anthropic", ".provider-logo-claude", "/providers/anthropic.svg"],
      ["xai", ".provider-logo-grok", "/providers/xai.svg"],
      ["deepseek", ".provider-logo-deepseek", "/providers/deepseek.svg"],
      ["openrouter", ".provider-logo-openrouter", "/providers/openrouter.svg"],
      ["xiaomi", ".provider-logo-xiaomi", "/providers/xiaomi.svg"],
    ];
    const { container, rerender } = render(<ProviderLogo id="openai" />);
    for (const [id, selector, path] of cases) {
      rerender(<ProviderLogo id={id} label={id} />);
      const node = container.querySelector(selector);
      expect(node, `${id} → ${selector}`).toBeTruthy();
      expect(node?.getAttribute("style")).toContain(path);
    }

    rerender(<ProviderLogo id="zai" label="DeepSeek" />);
    expect(container.querySelector(".provider-logo-fallback")?.textContent).toBe("DE");
  });
});
