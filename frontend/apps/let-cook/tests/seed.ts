import type { Page } from "@playwright/test";

/**
 * Agent state the browser suites seed through `window.__cookMockSeed`.
 *
 * A credentialed provider keeps the first-run connect flow out of the way for tests that are
 * about the shell rather than onboarding; the onboarding tests seed nothing.
 */
export const CONNECTED_SEED = {
  providers: [
    {
      id: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiBackend: "chat_completions",
      apiKey: "sk-mock-0123456789abcdef",
      models: [
        { id: "gpt-5", name: "GPT-5", input: ["text", "image"] },
        { id: "o4-mini", name: "o4-mini", input: ["text"] },
      ],
    },
  ],
  defaultModel: "gpt-5",
};

/** Seed the mock agent's state before the app boots. */
export async function seedAgent(page: Page, seed: Record<string, unknown>) {
  await page.addInitScript((value) => {
    (window as unknown as { __cookMockSeed?: unknown }).__cookMockSeed = value;
  }, seed);
}
