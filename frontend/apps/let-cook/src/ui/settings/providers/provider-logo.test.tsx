import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { isOauthProvider, oauthProviderName, ProviderLogo } from "./provider-logo";

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

  it("renders the copied Quac marks on the oauth providers", () => {
    const { container, rerender } = render(<ProviderLogo id="openai" />);
    expect(container.querySelector(".provider-logo-openai")).toBeTruthy();
    rerender(<ProviderLogo id="anthropic" />);
    expect(container.querySelector(".provider-logo-claude")).toBeTruthy();
    rerender(<ProviderLogo id="xai" />);
    expect(container.querySelector(".provider-logo-grok")).toBeTruthy();
    rerender(<ProviderLogo id="deepseek" label="DeepSeek" />);
    expect(container.querySelector(".provider-logo-fallback")?.textContent).toBe("DE");
  });
});
