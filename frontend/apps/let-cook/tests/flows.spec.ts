import { expect, test, type Locator, type Page } from "@playwright/test";
import { CONNECTED_SEED, seedAgent } from "./seed";

/**
 * End-to-end flows through the shipped renderer over the recording mock ACP transport.
 *
 * `VITE_MOCK_ACP=1` makes `src/acp/host.ts` swap the Tauri IPC bridge for
 * `src/acp/mock-transport.ts`; every mutation the UI performs is therefore an ACP request we can
 * read back, and the agent's own state is asserted after the fact.
 */

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** The plan file name the mock agent reports for the episode it reviews. */
const PLAN_FILE = "2026-09-19T14-30-22Z.md";

type Recorded = { method: string; params: Record<string, unknown>; at: number };

function api(page: Page) {
  return {
    requests: (): Promise<Recorded[]> => page.evaluate(() => window.__cookMock!.requests()),
    state: (): Promise<Record<string, unknown>> =>
      page.evaluate(() => window.__cookMock!.state() as unknown as Record<string, unknown>),
    responses: (): Promise<Array<{ id: number | string; result: unknown }>> =>
      page.evaluate(() => window.__cookMock!.responses()),
    elicit: (overrides?: Record<string, unknown>) =>
      page.evaluate((value) => window.__cookMock!.elicit(value ?? {}), overrides ?? {}),
    modelsUpdate: (params?: Record<string, unknown>) =>
      page.evaluate((value) => window.__cookMock!.modelsUpdate(value ?? {}), params ?? {}),
  };
}

/** Load the app with a seeded agent state, then open the workspace. */
async function openWorkspace(page: Page, seed: Record<string, unknown> = {}) {
  await seedAgent(page, seed);
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.waitForFunction(() => Boolean(window.__cookMock));
  await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
}

function callsTo(requests: Recorded[], method: string): Recorded[] {
  return requests.filter((entry) => entry.method === method);
}

/** Wait until the renderer has sent at least `count` calls of `method`, then return them. */
async function waitForCalls(page: Page, method: string, count = 1): Promise<Recorded[]> {
  await expect.poll(async () => callsTo(await api(page).requests(), method).length, { timeout: 5000 }).toBeGreaterThanOrEqual(count);
  return callsTo(await api(page).requests(), method);
}

/** Dispatch a real HTML5 drop carrying one file, the way a browser (non-Tauri) load delivers it. */
async function dropFile(page: Page, name: string, base64: string) {
  await page.getByTestId("composer-drop").evaluate((node, payload) => {
    const bytes = Uint8Array.from(atob(payload.base64), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], payload.name, { type: "image/png" }));
    node.dispatchEvent(new DragEvent("dragover", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    node.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, { name, base64 });
}

/** Dispatch a real paste event carrying one image file, as a screenshot clipboard would. */
async function pasteFile(page: Page, name: string, base64: string) {
  await page.getByPlaceholder("Ask Cook anything…").evaluate((node, payload) => {
    const bytes = Uint8Array.from(atob(payload.base64), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], payload.name, { type: "image/png" }));
    node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, { name, base64 });
}

/** The image part the renderer put on the wire for this prompt, if any. */
async function imagePart(page: Page, mock: ReturnType<typeof api>) {
  const content = (await mock.requests()).filter((entry) => entry.method === "session/prompt");
  const parts = (content.at(-1)?.params.prompt ?? []) as Array<Record<string, unknown>>;
  return parts.find((part) => part.type === "image");
}

/** A credentialed provider so the first-run wizard stays out of the way. */

test.describe("first run", () => {
  test("connects a provider end to end without touching TOML", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const mock = api(page);
    await openWorkspace(page);

    // No provider and no agent credential: the connect flow replaces the chat.
    await expect(page.getByTestId("connect-provider")).toBeVisible();
    await expect(page.getByTestId("preset-deepseek")).toBeVisible();
    await expect(page.getByTestId("preset-ollama")).toHaveCount(0);
    await expect(page.getByTestId("preset-custom")).toHaveCount(0);

    await page.getByTestId("preset-deepseek").click();
    await expect(page.getByLabel("Base URL")).toHaveValue("https://api.deepseek.com");
    await page.getByLabel("API key").fill("sk-live-deepseek-0123456789abcd");

    // Test must report a visible result for the provider's own endpoint.
    await page.getByTestId("provider-test").click();
    const result = page.getByTestId("provider-test-result");
    await expect(result).toBeVisible();
    await expect(result).toContainText("Connected (HTTP 200)");
    await expect(result).toContainText("https://api.deepseek.com");

    await page.getByTestId("provider-save").click();

    // Default model step, then the empty chat.
    await expect(page.getByTestId("connect-default-step")).toBeVisible();
    await page.getByTestId("connect-default-model").selectOption("deepseek-reasoner");
    await page.getByTestId("connect-finish").click();
    await expect(page.getByTestId("connect-provider")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();

    // Every mutation was an ACP request, and the key never came back out.
    const requests = await mock.requests();
    const upsert = callsTo(requests, "x.ai/providers/upsert");
    expect(upsert).toHaveLength(1);
    expect(upsert[0].params).toMatchObject({
      id: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-live-deepseek-0123456789abcd",
    });
    expect((upsert[0].params.models as Array<Record<string, unknown>>).map((model) => model.id)).toContain("deepseek-chat");
    expect(callsTo(requests, "x.ai/providers/test")[0].params).toMatchObject({ id: "deepseek" });
    expect(callsTo(requests, "x.ai/models/set_default")[0].params).toEqual({ modelId: "deepseek-reasoner" });
    await expect.poll(async () => (await mock.state()).defaultModel).toBe("deepseek-reasoner");
    // The agent holds the key; credentials never come back to the renderer.
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Models" }).click();
    await expect(page.getByTestId("provider-row-deepseek")).toContainText("Connected · API key");
    await expect(page.locator(".settings-panel")).not.toContainText("sk-live-deepseek-0123456789abcd");
    expect(errors).toEqual([]);
  });

  test("merges models discovered from the provider's own /models", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page);
    await page.getByTestId("preset-openai").click();
    await page.getByLabel("API key").fill("sk-mock-0123456789abcdef");
    await page.getByTestId("provider-discover").click();
    await expect(page.getByTestId("provider-discovered")).toContainText("mock-discovered-model");
    await waitForCalls(page, "x.ai/providers/discover_models");

    await page.getByTestId("provider-save").click();
    await expect(page.getByTestId("connect-default-step")).toBeVisible();
    const upsert = await waitForCalls(page, "x.ai/providers/upsert");
    const ids = (upsert[0].params.models as Array<{ id: string }>).map((model) => model.id);
    expect(ids).toContain("mock-discovered-model");
    expect(ids).toContain("gpt-5");
  });

  test("keeps the provider across a reload with localStorage cleared", async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId("preset-deepseek").click();
    await page.getByLabel("API key").fill("sk-live-deepseek-0123456789abcd");
    await page.getByTestId("provider-save").click();
    await expect(page.getByTestId("connect-default-step")).toBeVisible();
    await page.getByTestId("connect-finish").click();
    await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();

    // The credential lives with the agent, never in the window's own storage.
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("sk-live-deepseek");
    expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain("sk-live-deepseek");
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    await openWorkspace(page);
    await expect(page.getByTestId("connect-provider")).toHaveCount(0);
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Models" }).click();
    await expect(page.getByTestId("provider-row-deepseek")).toContainText("Connected · API key");
  });

  test("surfaces a rejected credential instead of pretending it worked", async ({ page }) => {
    await openWorkspace(page, { testFails: true });
    await page.getByTestId("preset-openai").click();
    await page.getByLabel("API key").fill("sk-bad-key-0123456789");
    await page.getByTestId("provider-test").click();
    const result = page.getByTestId("provider-test-result");
    await expect(result).toContainText("Failed");
    await expect(result).toContainText("401");
  });

  test("never shows a key the user already saved through the CLI", async ({ page }) => {
    await openWorkspace(page, CONNECTED_SEED);
    await expect(page.getByTestId("connect-provider")).toHaveCount(0);
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Models" }).click();
    await expect(page.getByTestId("provider-row-openai")).toContainText("Connected · API key");
    await expect(page.getByTestId("provider-row-openai")).not.toContainText("sk-m…cdef");
    await expect(page.locator(".settings-panel")).not.toContainText("sk-mock-0123456789abcdef");
  });

  test("skips the wizard for a CLI user whose config already works", async ({ page }) => {
    await openWorkspace(page, { authMethodId: "xai-session", defaultModel: "grok-4.5" });
    await expect(page.getByTestId("connect-provider")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Models" }).click();
    await expect(page.getByTestId("provider-row-xai")).toContainText("Connected · OAuth");
  });

  test("stays dismissed once the user skips it", async ({ page }) => {
    await openWorkspace(page);
    await expect(page.getByTestId("connect-provider")).toBeVisible();
    await page.getByTestId("connect-skip").click();
    await expect(page.getByTestId("connect-provider")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
    await expect(page.getByTestId("connect-provider")).toHaveCount(0);
  });
});

test.describe("chat, attachments and the model picker", () => {
  test("renders streamed assistant text and groups the model picker by provider", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);

    await page.getByPlaceholder("Ask Cook anything…").fill("What changed?");
    await page.getByTestId("send-button").click();
    await expect(page.getByText("Mock assistant reply.")).toBeVisible();
    await expect(page.getByText("What changed?")).toBeVisible();
    await expect(page.locator(".message-assistant")).toHaveCount(1);
    await expect(page.locator(".message-assistant")).toContainText("Mock assistant reply.");

    const prompt = await waitForCalls(page, "session/prompt");
    expect(prompt[0].params.prompt).toEqual([{ type: "text", text: "What changed?" }]);

    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Models" }).click();
    const groups = await page
      .getByTestId("settings-default-model")
      .locator("optgroup")
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptGroupElement).label));
    expect(groups).toEqual(["openai"]);
    expect(errors).toEqual([]);
  });

  test("keeps composer input stable while a delayed stream is running", async ({ page }) => {
    await openWorkspace(page, {
      ...CONNECTED_SEED,
      promptDelayMs: 1_500,
      reply: "A delayed mock response.",
    });

    const input = page.getByTestId("composer-input");
    await input.fill("start the delayed turn");
    await page.getByTestId("send-button").click();
    await expect(page.getByTestId("turn-status")).toBeVisible();

    await input.fill("typed while the response is running");
    await expect(input).toHaveValue("typed while the response is running");
  });

  test("windows a long history and returns from scrolled-up mode", async ({ page }) => {
    const historyUpdates = Array.from({ length: 100 }, (_, index) => [
      {
        sessionUpdate: "user_message_chunk",
        messageId: `history-user-${index}`,
        content: { type: "text", text: `Long prompt ${index}` },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `Long response ${index}` },
      },
    ]).flat();
    await openWorkspace(page, {
      ...CONNECTED_SEED,
      sessions: [{ id: "long-history", title: "Long transcript", cwd: "/tmp/cook-demo", updatedAt: "2026-09-18T10:00:00Z" }],
      historyUpdates,
    });

    const session = page.locator(".session-open").filter({ hasText: "Long transcript" });
    await expect(session).toBeVisible();
    await session.click();
    await expect(page.getByText("Long response 99")).toBeVisible();
    await expect.poll(() => page.locator(".transcript-row").count()).toBeLessThan(64);

    const transcript = page.locator(".transcript");
    await transcript.evaluate((node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
    await expect(page.getByText("Long response 99")).toHaveCount(0);

    await page.getByRole("button", { name: "Jump to latest" }).click();
    await expect(page.getByText("Long response 99")).toBeVisible();
    await expect.poll(async () => transcript.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(96);

    await transcript.evaluate((node) => {
      node.scrollTop = Math.min(900, node.scrollHeight / 2);
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect(page.getByTestId("sticky-prompt")).toBeVisible();
    await expect(page.getByRole("button", { name: "Jump to start of response" })).toBeVisible();

    const input = page.getByTestId("composer-input");
    await input.focus();
    const beforePageUp = await transcript.evaluate((node) => node.scrollTop);
    await input.press("PageUp");
    await expect.poll(() => transcript.evaluate((node) => node.scrollTop)).toBeLessThan(beforePageUp);
    const beforePageDown = await transcript.evaluate((node) => node.scrollTop);
    await input.press("PageDown");
    await expect.poll(() => transcript.evaluate((node) => node.scrollTop)).toBeGreaterThan(beforePageDown);

    await transcript.evaluate((node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
    await input.fill("send from scrolled history");
    await page.getByTestId("send-button").click();
    await expect(page.getByText("Mock assistant reply.")).toBeVisible();
    await expect.poll(async () => transcript.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(96);
  });

  test("adds a model through the add-model popup", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Models" }).click();
    await page.getByTestId("provider-add-model-openai").click();
    await page.getByLabel("Model ID for openai").fill("gpt-custom");
    await page.getByLabel("Model display name").fill("GPT Custom");
    await page.getByTestId("model-save").click();
    const upserts = await waitForCalls(page, "x.ai/models/upsert");
    expect(upserts.at(-1)?.params).toMatchObject({ id: "gpt-custom", providerId: "openai", contextWindow: 300000, maxCompletionTokens: 64000, input: ["text"] });
    await expect(page.getByTestId("model-row-gpt-custom")).toContainText("GPT Custom");
    await expect(page.getByTestId("model-row-gpt-custom")).toContainText("gpt-custom");

    // Removing it deletes the `[model.*]` row, so it leaves the panel for good.
    await page.getByTestId("model-remove-gpt-custom").click();
    await page.getByRole("dialog", { name: "Remove GPT Custom?" }).getByTestId("model-remove-confirm").click();
    await expect(page.getByTestId("model-row-gpt-custom")).toHaveCount(0);
    const state = await mock.state();
    const openai = (state.providers as Array<{ id: string; models: Array<{ id: string }> }>).find((provider) => provider.id === "openai")!;
    expect(openai.models.map((model) => model.id)).not.toContain("gpt-custom");
  });

  test("offers the provider's own models and seeds the limits from them", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, {
      ...CONNECTED_SEED,
      discoverable: [
        { id: "gpt-5-mini", name: "GPT-5 Mini", contextWindow: 400_000, maxCompletionTokens: 128_000 },
        { id: "gpt-5-nano", name: "GPT-5 Nano", contextWindow: 200_000 },
        { id: "o4", name: "o4", contextWindow: 100_000, maxCompletionTokens: 32_000 },
        { id: "gpt-4.1", name: "GPT-4.1" },
        { id: "gpt-4o", name: "GPT-4o" },
        { id: "gpt-4o-mini", name: "GPT-4o Mini" },
      ],
    });
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Models" }).click();
    await page.getByTestId("provider-add-model-openai").click();
    await page.getByTestId("model-get-models").click();
    await waitForCalls(page, "x.ai/providers/probe_models");

    // Five picks at most, and never an id the provider already has.
    const candidates = page.getByTestId("model-candidates").getByRole("button");
    await expect(candidates).toHaveCount(5);
    await expect(page.getByTestId("model-candidates")).not.toContainText("o4-mini");

    // The baseline context wins over a larger one, while output comes from the listing.
    await candidates.filter({ hasText: "GPT-5 Mini" }).click();
    await expect(page.getByLabel("Model ID for openai")).toHaveValue("gpt-5-mini");
    await expect(page.getByLabel("Model context window")).toHaveValue("300000");
    await expect(page.getByLabel("Model output limit")).toHaveValue("128000");

    // A model that declares less than the baseline keeps its own context window.
    await candidates.filter({ hasText: "o4" }).first().click();
    await expect(page.getByLabel("Model ID for openai")).toHaveValue("o4");
    await expect(page.getByLabel("Model context window")).toHaveValue("100000");
    await expect(page.getByLabel("Model output limit")).toHaveValue("32000");
    await page.getByTestId("model-save").click();

    const upserts = await waitForCalls(page, "x.ai/models/upsert");
    expect(upserts.at(-1)?.params).toMatchObject({ id: "o4", providerId: "openai", contextWindow: 100000, maxCompletionTokens: 32000 });
    // Reading the listing must not configure anything on its own.
    expect(callsTo(await mock.requests(), "x.ai/models/upsert")).toHaveLength(1);
  });

  test("reports a failed listing inside the add-model popup", async ({ page }) => {
    await openWorkspace(page, { ...CONNECTED_SEED, probeFails: true });
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Models" }).click();
    await page.getByTestId("provider-add-model-openai").click();
    await page.getByTestId("model-get-models").click();
    await expect(page.getByTestId("model-error")).toContainText("401");
    // The id field still works, so a failed listing is not a dead end.
    await page.getByLabel("Model ID for openai").fill("gpt-5-mini");
    await expect(page.getByTestId("model-save")).toBeEnabled();
  });

  test("shows all supported providers and opens a closable add-provider dialog", async ({ page }) => {
    await openWorkspace(page, CONNECTED_SEED);
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Models" }).click();
    await expect(page.locator("[data-testid^='provider-row-']")).toHaveCount(8);
    await expect(page.getByTestId("provider-row-openai")).toContainText("Connected · API key");
    await expect(page.getByTestId("provider-row-anthropic")).toContainText("Not connected");
    await page.getByTestId("provider-add").click();
    const dialog = page.getByRole("dialog", { name: "Add provider" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Choose a provider")).toHaveCount(0);
    await dialog.getByLabel("Close dialog").click();
    await expect(dialog).toHaveCount(0);
  });

  test("edits a provider's name, then removes it and its models from config", async ({ page }) => {
    const mock = api(page);
    const twoProviders = {
      ...CONNECTED_SEED,
      providers: [
        ...CONNECTED_SEED.providers,
        { id: "deepseek", baseUrl: "https://api.deepseek.com", apiBackend: "chat_completions", apiKey: "sk-ds-0123456789abcdef", models: [{ id: "deepseek-chat", name: "DeepSeek Chat", input: ["text"] }] },
      ],
    };
    await openWorkspace(page, twoProviders);
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Models" }).click();

    const row = page.getByTestId("provider-row-openai");
    await expect(row).not.toContainText("sk-m…cdef");
    await page.getByTestId("provider-edit-openai").click();
    const editor = page.getByRole("dialog", { name: "Edit OpenAI" });
    await expect(editor.getByText(/Current key:/)).toHaveCount(0);
    await expect(editor.getByText("A saved API key will be kept when this field is blank.")).toBeVisible();
    // Connection settings only: models live on the provider row.
    await expect(editor.getByText("Extra model IDs")).toHaveCount(0);
    await expect(editor.getByTestId("provider-discover")).toHaveCount(0);
    await editor.getByLabel("Provider name").fill("Team OpenAI");
    await editor.getByTestId("provider-save").click();
    await expect(row).toContainText("Team OpenAI");
    // A connection-only edit carries no model seeds, so the saved models must survive untouched.
    await expect(page.getByTestId("model-row-gpt-5")).toBeVisible();
    const edited = (await mock.state()).providers as Array<{ id: string; models: Array<{ id: string; model?: string; name?: string }> }>;
    expect(edited.find((provider) => provider.id === "openai")?.models).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "gpt-5", name: "GPT-5" })]),
    );

    // Remove deletes the provider table and its models, not just the saved key.
    await page.getByTestId("provider-remove-openai").click();
    const confirm = page.getByRole("dialog", { name: "Remove Team OpenAI?" });
    await expect(confirm).toContainText("[model_providers.openai]");
    await confirm.getByTestId("provider-remove-confirm").click();

    // gpt-5 is the default and belongs to openai, so the host refuses until one is chosen.
    const replacement = page.getByRole("dialog", { name: "Choose the new default model" });
    await expect(replacement).toBeVisible();
    await replacement.getByTestId("replacement-model").selectOption("deepseek-chat");
    await replacement.getByRole("button", { name: "Remove provider" }).click();

    await expect(page.getByTestId("model-row-gpt-5")).toHaveCount(0);
    await expect(page.getByTestId("provider-connect-openai")).toBeVisible();
    const state = await mock.state();
    expect((state.providers as Array<{ id: string }>).map((provider) => provider.id)).toEqual(["deepseek"]);
    expect(state.defaultModel).toBe("deepseek-chat");
  });

  test("shows model context, output and input and edits them in a popup", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Models" }).click();

    const row = page.getByTestId("model-row-gpt-5");
    await expect(row).toContainText("Context 300K");
    await expect(row).toContainText("Output 64K");
    await expect(row).toContainText("Input text + image");
    await page.getByLabel("Edit model gpt-5").click();
    const editor = page.getByRole("dialog", { name: "Edit GPT-5" });
    await editor.getByLabel("Model context window").fill("256000");
    await editor.getByLabel("Model output limit").fill("32000");
    await editor.getByLabel("Image").uncheck();
    await editor.getByRole("button", { name: "Save model" }).click();
    const call = (await waitForCalls(page, "x.ai/models/upsert")).at(-1)!;
    expect(call.params).toMatchObject({ id: "gpt-5", providerId: "openai", contextWindow: 256000, maxCompletionTokens: 32000, input: ["text"] });
    await expect(row).toContainText("Context 256K");
    await expect(row).toContainText("Output 32K");
    expect((await mock.state()).providers).toEqual(expect.arrayContaining([expect.objectContaining({ id: "openai" })]));
  });

  test("edits context and output for a local model through the same model settings path", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, {
      ...CONNECTED_SEED,
      providers: [
        ...CONNECTED_SEED.providers,
        {
          id: "local",
          name: "Local API",
          baseUrl: "http://localhost:8080/v1",
          apiBackend: "chat_completions",
          apiKey: "local-test-key",
          models: [{
            id: "local/spark25",
            model: "spark25",
            name: "Spark 2.5 (Local)",
            input: ["text"],
            contextWindow: 32_768,
            maxCompletionTokens: 2_000,
          }],
        },
      ],
    });
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Models" }).click();

    const row = page.getByTestId("model-row-local/spark25");
    await expect(row).toContainText("Context 32.8K");
    await expect(row).toContainText("Output 2K");
    await page.getByLabel("Edit model local/spark25").click();
    const editor = page.getByRole("dialog", { name: "Edit Spark 2.5 (Local)" });
    await editor.getByLabel("Model context window").fill("65536");
    await editor.getByLabel("Model output limit").fill("4096");
    await editor.getByRole("button", { name: "Save model" }).click();

    const call = (await waitForCalls(page, "x.ai/models/upsert")).at(-1)!;
    expect(call.params).toMatchObject({
      id: "local/spark25",
      model: "spark25",
      providerId: "local",
      contextWindow: 65_536,
      maxCompletionTokens: 4_096,
      input: ["text"],
    });
    await expect(row).toContainText("Context 65.5K");
    await expect(row).toContainText("Output 4.1K");
    const state = await mock.state();
    const local = (state.providers as Array<{ id: string; models: Array<{ id: string; contextWindow?: number; maxCompletionTokens?: number }> }>).find((provider) => provider.id === "local")!;
    expect(local.models).toEqual(expect.arrayContaining([expect.objectContaining({ id: "local/spark25", contextWindow: 65_536, maxCompletionTokens: 4_096 })]));
  });

  test("re-lists the catalog when the agent broadcasts an empty models update", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    const picker = page.getByLabel("Model");
    await expect(picker).toHaveValue("gpt-5");
    const listed = (await waitForCalls(page, "x.ai/models/list")).length;

    // The machine-wide form of `x.ai/models/update` has no payload: it says the catalog moved on
    // disk. Adopting it as a catalog would leave the picker empty and the selection dangling.
    await mock.modelsUpdate();
    await waitForCalls(page, "x.ai/models/list", listed + 1);
    await expect(picker).toHaveValue("gpt-5");
    await expect(picker.locator("option")).toHaveCount(2);
  });

  test("attaches an image as a base64 image part with its media type", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);

    await page.getByTestId("attach-input").setInputFiles({
      name: "shot.png",
      mimeType: "image/png",
      buffer: Buffer.from(PNG_BASE64, "base64"),
    });
    await expect(page.getByTestId("attachment-row")).toContainText("shot.png");
    await page.getByPlaceholder("Ask Cook anything…").fill("what is in this image?");
    await page.getByTestId("send-button").click();
    await expect(page.getByText("Mock assistant reply.")).toBeVisible();

    const content = (await waitForCalls(page, "session/prompt"))[0].params.prompt as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "what is in this image?" });
    expect(content[1]).toEqual({ type: "image", mimeType: "image/png", data: PNG_BASE64 });
    // The transcript renders the image the user sent.
    await expect(page.locator(".message-user img")).toHaveCount(1);
  });

  test("attaches an image dropped onto the composer", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);

    await dropFile(page, "dropped.png", PNG_BASE64);
    await expect(page.getByTestId("attachment-row")).toContainText("dropped.png");
    await page.getByPlaceholder("Ask Cook anything…").fill("dropped this in");
    await page.getByTestId("send-button").click();
    await expect(page.getByText("Mock assistant reply.")).toBeVisible();

    await expect.poll(async () => (await imagePart(page, mock))?.data).toBe(PNG_BASE64);
    await expect(page.locator(".message-user img")).toHaveCount(1);
  });

  test("attaches an image pasted into the composer", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);

    await pasteFile(page, "pasted.png", PNG_BASE64);
    await expect(page.getByTestId("attachment-row")).toContainText("pasted.png");
    await page.getByPlaceholder("Ask Cook anything…").fill("pasted this");
    await page.getByTestId("send-button").click();
    await expect(page.getByText("Mock assistant reply.")).toBeVisible();

    await expect.poll(async () => (await imagePart(page, mock))?.data).toBe(PNG_BASE64);
  });

  test("refuses an image on a text-only model with a visible reason", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, { ...CONNECTED_SEED, defaultModel: "o4-mini" });
    await page.getByTestId("attach-input").setInputFiles({
      name: "shot.png",
      mimeType: "image/png",
      buffer: Buffer.from(PNG_BASE64, "base64"),
    });
    await expect(page.getByTestId("attachment-row")).toHaveCount(0);
    await expect(page.getByTestId("chat-error")).toContainText("cannot read images");
    await expect(page.getByTestId("error-banner")).toHaveCount(0);
    await page.getByLabel("Dismiss error").click();
    await expect(page.getByTestId("chat-error")).toHaveCount(0);
    expect(callsTo(await mock.requests(), "session/prompt")).toHaveLength(0);
  });

  test("sends a file picked through the native picker as a path the agent can read", async ({ page }) => {
    const mock = api(page);
    // The native picker returns paths; a webview file input never exposes one.
    await openWorkspace(page, { ...CONNECTED_SEED, pickedFiles: ["/tmp/cook-demo/report.pdf"] });
    await page.getByTestId("attach-button").click();
    await expect(page.getByTestId("attachment-row")).toContainText("report.pdf");
    await page.getByPlaceholder("Ask Cook anything…").fill("summarise this");
    await page.getByTestId("send-button").click();
    await expect(page.getByText("Mock assistant reply.")).toBeVisible();
    const parts = (await waitForCalls(page, "session/prompt"))[0].params.prompt as Array<Record<string, unknown>>;
    expect(parts.find((part) => part.type === "resource_link")).toMatchObject({
      name: "report.pdf",
      uri: "file:///tmp/cook-demo/report.pdf",
    });
    expect(JSON.stringify(parts)).toContain("read_file");
    expect(JSON.stringify(parts)).not.toContain("base64");
  });

  test("reads a picked image inline as an image part", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, {
      ...CONNECTED_SEED,
      pickedFiles: ["/tmp/cook-demo/diagram.png"],
      filePayloads: { "/tmp/cook-demo/diagram.png": { data: PNG_BASE64, mediaType: "image/png", size: 70 } },
    });
    await page.getByTestId("attach-button").click();
    await expect(page.getByTestId("attachment-row")).toContainText("diagram.png");
    await page.getByPlaceholder("Ask Cook anything…").fill("describe this diagram");
    await page.getByTestId("send-button").click();
    await expect(page.getByText("Mock assistant reply.")).toBeVisible();
    const parts = (await waitForCalls(page, "session/prompt"))[0].params.prompt as Array<Record<string, unknown>>;
    expect(parts[1]).toEqual({ type: "image", mimeType: "image/png", data: PNG_BASE64 });
  });
});

test.describe("command palette", () => {
  test("opens on Ctrl+K and runs the chosen item", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);

    await page.keyboard.press("Control+k");
    const palette = page.getByTestId("command-palette");
    await expect(palette).toBeVisible();

    // Sessions are searchable by title, and activating one loads it through the agent.
    await page.getByTestId("palette-input").fill("login");
    await page.getByTestId("palette-item-session-session-login").click();
    await expect(palette).toHaveCount(0);
    const loaded = await waitForCalls(page, "session/load");
    expect(loaded.some((entry) => entry.params.sessionId === "session-login")).toBe(true);

    // Models and slash commands live in the same list, and both take effect.
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("o4-mini");
    await page.getByTestId("palette-item-model-o4-mini").click();
    await expect.poll(async () => (await mock.state()).defaultModel).toBe("o4-mini");

    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("goal");
    await page.getByTestId("palette-item-command-goal").click();
    await expect(page.getByPlaceholder("Ask Cook anything…")).toHaveValue("/goal ");

    // Settings is reachable from the palette too.
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("settings");
    await page.getByTestId("palette-item-action-settings").click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("slash commands", () => {
  const composer = (page: Page) => page.getByPlaceholder("Ask Cook anything…");
  // The menu highlights the entry under the pointer, so pick the highlighted row deliberately.
  const hoverEntry = (page: Page, name: string) => page.getByTestId(`slash-item-${name}`).hover();

  test("offers the window's commands and the agent's, and completes on Tab", async ({ page }) => {
    await openWorkspace(page, CONNECTED_SEED);

    await composer(page).fill("/");
    await expect(page.getByTestId("slash-menu")).toBeVisible();
    // The window answers `/plan` itself; `/goal` belongs to the agent and travels as a prompt.
    await expect(page.getByTestId("slash-item-plan")).toBeVisible();
    await expect(page.getByTestId("slash-item-goal")).toBeVisible();

    await hoverEntry(page, "plan");
    await page.keyboard.press("Tab");
    await expect(composer(page)).toHaveValue("/plan ");

    // A partial name completes on Enter rather than being sent to the agent.
    await composer(page).fill("/goa");
    await hoverEntry(page, "goal");
    await page.keyboard.press("Enter");
    await expect(composer(page)).toHaveValue("/goal ");

    // Arguments close the menu: the text is the command's input, not another name.
    await composer(page).fill("/goal status");
    await expect(page.getByTestId("slash-menu")).toHaveCount(0);
  });

  test("runs /plan, then leaves plan mode from Settings", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);

    await composer(page).fill("/plan");
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("notice-banner")).toContainText("Plan mode is on");
    await expect(page.getByTestId("composer-plan-flag")).toBeVisible();
    await expect(page.locator(".composer.plan-mode")).toBeVisible();
    await expect(page.locator(".plan-banner")).toHaveCount(0);
    const modes = await waitForCalls(page, "session/set_mode");
    expect(modes[0].params).toMatchObject({ sessionId: "mock-session", modeId: "plan" });
    expect((await mock.state()).sessionMode).toBe("plan");

    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "General" }).click();
    await page.getByRole("checkbox", { name: "Plan mode" }).click();
    await expect.poll(async () => (await mock.state()).sessionMode).toBe("default");
    await expect(page.getByTestId("composer-plan-flag")).toHaveCount(0);
    await expect(page.locator(".plan-banner")).toHaveCount(0);
  });

  test("sends /plan's description as the first turn once the mode is on", async ({ page }) => {
    await openWorkspace(page, CONNECTED_SEED);
    await composer(page).fill("/plan add auth to the app");
    await page.keyboard.press("Enter");

    const modes = await waitForCalls(page, "session/set_mode");
    const prompts = await waitForCalls(page, "session/prompt");
    expect(modes[0].params.modeId).toBe("plan");
    expect(prompts[0].params.prompt).toEqual([{ type: "text", text: "add auth to the app" }]);
    // The turn was sent, so the window has nothing extra to say about it.
    await expect(page.getByTestId("notice-banner")).toHaveCount(0);
  });

  test("switches the model from the composer", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);

    await composer(page).fill("/model");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("notice-banner")).toContainText("gpt-5");

    await composer(page).fill("/model o4-mini");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("notice-banner")).toContainText("Model is now o4-mini.");
    await expect(page.getByLabel("Model")).toHaveValue("o4-mini");

    // No session yet, so the choice reaches the agent when the first turn spawns one.
    await composer(page).fill("hello");
    await page.getByTestId("send-button").click();
    const created = (await waitForCalls(page, "session/new"))[0];
    expect(created.params._meta).toMatchObject({ modelId: "o4-mini" });
    expect((await mock.state()).defaultModel).toBe("o4-mini");
  });

  test("reports context usage, and turns always-approve on where the agent can see it", async ({ page }) => {
    await openWorkspace(page, CONNECTED_SEED);

    // A turn is what makes the agent report context usage; the header shows it from then on,
    // out of `x.ai/session/info` — a real turn sends no `usage_update`.
    await composer(page).fill("hello");
    await page.getByTestId("send-button").click();
    await expect(page.getByText("Mock assistant reply.")).toBeVisible();
    await expect(page.getByTestId("context-chip")).toBeVisible();
    await waitForCalls(page, "x.ai/session/info");

    await page.getByLabel("Context status").hover();
    await expect(page.getByTestId("context-chip-percent")).toHaveText("0.90%");
    await expect(page.getByTestId("context-chip-meter")).toHaveAttribute("aria-valuenow", "1");

    await composer(page).fill("/context");
    await page.keyboard.press("Enter");
    const notice = page.getByTestId("notice-banner");
    await expect(notice).toContainText("Session mock-session");
    await expect(notice).toContainText("tokens");
    // Turns and messages come from the agent's own report, not from a local guess.
    await expect(notice).toContainText("1 turn");
    await expect(notice).toContainText("3 messages");

    await composer(page).fill("/always-approve on");
    await page.keyboard.press("Enter");
    await expect(notice).toContainText("Always-approve is on");
    const notified = await waitForCalls(page, "x.ai/yolo_mode_changed");
    expect(notified[0].params).toMatchObject({ yolo_mode: true, clientIdentifier: "grok-desktop" });

    // The setting has one home: the toggle in Settings shows what the command just did.
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "General" }).click();
    await expect(page.locator(".toggle-row", { hasText: "Always approve" }).getByRole("checkbox")).toBeChecked();
  });

  test("opens context actions inside the composer and queues /compact", async ({ page }) => {
    await openWorkspace(page, { ...CONNECTED_SEED, promptDelayMs: 250 });
    await composer(page).fill("hello");
    await page.getByTestId("send-button").click();
    await expect(page.getByTestId("turn-status")).toBeVisible();

    await page.getByLabel("Context status").click();
    await expect(page.getByRole("menuitem", { name: /compact/ })).toBeVisible();
    await page.getByRole("menuitem", { name: /compact/ }).click();

    const prompts = await waitForCalls(page, "session/prompt", 2);
    expect(prompts.at(-1)?.params.prompt).toEqual([{ type: "text", text: "/compact" }]);
  });

  test("picks a model before the first prompt and spawns the session on it", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);

    // No session yet, and the picker still works: the choice rides `session/new`'s `_meta.modelId`.
    await expect(page.getByLabel("Model")).toBeEnabled();
    await page.getByLabel("Model").selectOption("o4-mini");

    await composer(page).fill("What changed?");
    await page.getByTestId("send-button").click();
    await expect(page.getByText("Mock assistant reply.")).toBeVisible();

    const created = (await waitForCalls(page, "session/new"))[0];
    expect(created.params._meta).toMatchObject({ modelId: "o4-mini" });
    expect((await mock.state()).defaultModel).toBe("o4-mini");
    await expect(page.getByLabel("Model")).toHaveValue("o4-mini");
  });

  test("keeps a default the agent cannot write, and says where it applies", async ({ page }) => {
    const mock = api(page);
    // The shipped CLI predates `x.ai/models/set_default`; the window must not appear to ignore it.
    await openWorkspace(page, { ...CONNECTED_SEED, setDefaultUnsupported: true });

    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Models" }).click();
    await page.getByTestId("settings-default-model").selectOption("o4-mini");

    await expect(page.getByTestId("notice-banner")).toContainText("applies to this window only");
    await expect(page.getByTestId("settings-default-model")).toHaveValue("o4-mini");

    await page.getByLabel("Close settings").click();
    await expect(page.getByLabel("Model")).toHaveValue("o4-mini");
    await composer(page).fill("What changed?");
    await page.getByTestId("send-button").click();
    const created = (await waitForCalls(page, "session/new"))[0];
    expect(created.params._meta).toMatchObject({ modelId: "o4-mini" });
    expect((await mock.state()).defaultModel).toBe("o4-mini");
  });
});

test.describe("connectors", () => {
  test("lists the agent's MCP servers and toggles one through the agent", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    await page.getByRole("button", { name: "New chat" }).click();
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Connectors" }).click();

    await expect(page.getByTestId("connector-filesystem")).toContainText("npx -y @modelcontextprotocol/server-filesystem");
    await expect(page.getByTestId("connector-linear")).toContainText("Disabled");
    await page.getByLabel("Toggle filesystem").click();
    await expect(page.getByTestId("connector-filesystem")).toContainText("Disabled");

    const toggles = await waitForCalls(page, "x.ai/mcp/toggle");
    expect(toggles).toHaveLength(1);
    expect(toggles[0].params).toMatchObject({
      sessionId: "mock-session",
      session_id: "mock-session",
      serverName: "filesystem",
      server_name: "filesystem",
      enabled: false,
    });

    // Adding a stdio connector is an `x.ai/mcp/upsert` request as well.
    await page.getByTestId("connector-add").click();
    await page.getByLabel("Connector name").fill("github");
    await page.getByLabel("Connector command").fill("npx");
    await page.getByLabel("Connector arguments").fill("-y @modelcontextprotocol/server-github");
    await page.getByTestId("connector-save").click();
    await expect(page.getByTestId("connector-github")).toContainText("npx");
    const upsert = await waitForCalls(page, "x.ai/mcp/upsert");
    expect(upsert[0].params).toMatchObject({
      session_id: "mock-session",
      server_name: "github",
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });

    // The same form adds an HTTP connector.
    await page.getByTestId("connector-add").click();
    await page.getByRole("button", { name: "HTTP" }).click();
    await page.getByLabel("Connector name").fill("linear-http");
    await page.getByLabel("Connector URL").fill("https://mcp.example.com/sse");
    await page.getByTestId("connector-save").click();
    await expect(page.getByTestId("connector-linear-http")).toContainText("https://mcp.example.com/sse");
    expect((await waitForCalls(page, "x.ai/mcp/upsert", 2))[1].params).toMatchObject({
      server_name: "linear-http",
      type: "http",
      url: "https://mcp.example.com/sse",
    });
    expect(errors).toEqual([]);
  });

  test("groups MCP servers per connector and hides cross-connector mail tools", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const mock = api(page);
    await openWorkspace(page, {
      ...CONNECTED_SEED,
      mcpServers: [
        {
          name: "managed_gateway:cursor",
          displayName: "Cursor",
          transport: "managedGateway",
          source: "managed",
          enabled: true,
          toolCount: 0,
          tools: [
            { name: "browser_navigate", enabled: true, displayName: "Navigate" },
            { name: "gmail__search", enabled: true, displayName: "Search Gmail" },
            { name: "mail", enabled: true, displayName: "Mail" },
          ],
        },
        {
          name: "managed_gateway:gmail",
          displayName: "Gmail",
          transport: "managedGateway",
          source: "managed",
          enabled: true,
          toolCount: 0,
          tools: [{ name: "gmail__search", enabled: true, displayName: "Search Gmail" }],
        },
        { name: "filesystem", transport: "stdio", command: "npx", args: ["-y", "fs"], enabled: true, toolCount: 1, tools: [{ name: "read_file", enabled: true }] },
        { name: "acme-search", transport: "stdio", command: "npx", args: ["-y", "acme"], sourceLabel: "plugin: acme", enabled: true, toolCount: 0, tools: [] },
      ],
    });
    await page.getByRole("button", { name: "New chat" }).click();
    await waitForCalls(page, "session/new");
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Connectors" }).click();

    // Per-connector headers use display names, never the raw managed_gateway: wire id.
    await expect(page.getByTestId("mcp-section:managed:cursor")).toContainText("Cursor");
    await expect(page.getByTestId("mcp-section:managed:gmail")).toContainText("Gmail");
    await expect(page.getByText("managed_gateway:cursor")).toHaveCount(0);
    await expect(page.getByText("Managed by grok.com")).toBeVisible();

    // Mail tools that belong on Gmail are hidden under Cursor when both connectors are listed.
    await expect(page.getByTestId("connector-tool-managed_gateway:cursor-browser_navigate")).toBeVisible();
    await expect(page.getByTestId("connector-tool-managed_gateway:cursor-gmail__search")).toHaveCount(0);
    await expect(page.getByTestId("connector-tool-managed_gateway:gmail-gmail__search")).toBeVisible();

    // Connector header issues one mcp/toggle for that server.
    await page.getByLabel("Toggle all Cursor").click();
    const cursorToggle = await waitForCalls(page, "x.ai/mcp/toggle", 1);
    expect(cursorToggle[0].params).toMatchObject({
      server_name: "managed_gateway:cursor",
      enabled: false,
    });

    const servers = (await mock.state()).mcpServers as Array<{ name: string; enabled: boolean }>;
    expect(servers.find((server) => server.name === "managed_gateway:cursor")?.enabled).toBe(false);
    expect(servers.find((server) => server.name === "managed_gateway:gmail")?.enabled).toBe(true);

    // Folding a connector hides its tools without touching other groups.
    await page.getByTestId("mcp-section:managed:cursor").getByRole("button", { name: /Cursor/ }).click();
    await expect(page.getByTestId("connector-tools-managed_gateway:cursor")).toHaveCount(0);
    await expect(page.getByTestId("connector-acme-search")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("toggles a tool and deletes a connector through the agent", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    await page.getByRole("button", { name: "New chat" }).click();
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Connectors" }).click();

    const tools = page.getByTestId("connector-tools-filesystem");
    await expect(tools).toBeVisible();
    await expect(page.getByTestId("connector-tool-filesystem-list_dir")).toBeVisible();
    await page.getByLabel("Toggle tool list_dir").click();
    const toolToggles = await waitForCalls(page, "x.ai/mcp/toggle_tool");
    // The shell decodes snake_case for every mutating MCP method, so the app must send both.
    expect(toolToggles[0].params).toMatchObject({
      sessionId: "mock-session",
      session_id: "mock-session",
      serverName: "filesystem",
      server_name: "filesystem",
      toolName: "list_dir",
      tool_name: "list_dir",
      enabled: true,
    });
    await expect.poll(async () => {
      const servers = (await mock.state()).mcpServers as Array<{ name: string; tools?: Array<{ name: string; enabled: boolean }> }>;
      return servers.find((server) => server.name === "filesystem")?.tools?.find((tool) => tool.name === "list_dir")?.enabled;
    }).toBe(true);

    await page.getByTestId("connector-delete-linear").click();
    await page.getByTestId("connector-delete-confirm").click();
    const deletes = await waitForCalls(page, "x.ai/mcp/delete");
    expect(deletes[0].params).toMatchObject({ session_id: "mock-session", server_name: "linear" });
    await expect(page.getByTestId("connector-linear")).toHaveCount(0);
    await expect.poll(async () => {
      const servers = (await mock.state()).mcpServers as Array<{ name: string }>;
      return servers.map((server) => server.name);
    }).toEqual(["managed_gateway:cursor", "managed_gateway:gmail", "filesystem"]);
    expect(errors).toEqual([]);
  });

  test("opens a session so the tool list can be annotated when Settings is opened first", async ({ page }) => {
    await openWorkspace(page, CONNECTED_SEED);
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Connectors" }).click();

    // Tools hang off the session's MCP pool: without a session the agent has nothing to annotate.
    await waitForCalls(page, "session/new");
    await expect(page.getByTestId("connector-tool-filesystem-list_dir")).toBeVisible();
    await expect(page.getByTestId("connector-tool-filesystem-read_file")).toBeVisible();
  });

  test("shows auth and setup actions when the agent requires them", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, {
      ...CONNECTED_SEED,
      mcpServers: [
        {
          name: "slack",
          transport: "http",
          url: "https://mcp.slack.example/sse",
          enabled: false,
          toolCount: 0,
          tools: [],
          authRequired: true,
        },
        {
          name: "notion",
          transport: "stdio",
          command: "npx",
          args: ["-y", "notion-mcp"],
          enabled: false,
          toolCount: 0,
          tools: [],
          setupRequired: true,
          setup: {
            fields: [
              {
                id: "workspace",
                label: "Workspace",
                type: "select",
                required: true,
                options: [
                  { label: "Personal", value: "personal" },
                  { label: "Team", value: "team" },
                ],
              },
            ],
          },
        },
      ],
    });
    await page.getByRole("button", { name: "New chat" }).click();
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Connectors" }).click();

    await page.getByTestId("connector-auth-status-slack").click();
    await waitForCalls(page, "x.ai/mcp/auth_status");
    await expect(page.getByTestId("connector-auth-note")).toContainText("slack");
    await page.getByTestId("connector-auth-trigger-slack").click();
    await waitForCalls(page, "x.ai/mcp/auth_trigger");

    await page.getByTestId("connector-setup-notion").click();
    const setupForm = page.getByTestId("connector-setup-form-notion");
    await expect(setupForm).toBeVisible();
    await setupForm.getByLabel("Workspace").selectOption("team");
    await page.getByTestId("connector-setup-save-notion").click();
    const setups = await waitForCalls(page, "x.ai/mcp/setup");
    expect(setups[0].params).toMatchObject({
      serverName: "notion",
      values: { workspace: "team" },
    });
    await expect(page.getByTestId("connector-setup-form-notion")).toHaveCount(0);
    await expect.poll(async () => {
      const servers = (await mock.state()).mcpServers as Array<{ name: string; setupRequired?: boolean }>;
      return servers.find((server) => server.name === "notion")?.setupRequired;
    }).toBe(false);
  });
});

test.describe("agent-driven surfaces", () => {
  test("answers an MCP elicitation in the interaction modal", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    const requestId = await mock.elicit();
    await expect(page.getByTestId("elicit-fields")).toBeVisible();
    await expect(page.getByTestId("elicit-accept")).toBeDisabled();
    await page.getByTestId("elicit-path").fill("/home/demo/projects");
    await page.getByTestId("elicit-depth").fill("2");
    await page.getByTestId("elicit-accept").click();
    await expect(page.getByTestId("elicit-fields")).toHaveCount(0);
    const answer = (await mock.responses()).find((entry) => entry.id === requestId);
    expect(answer?.result).toEqual({ outcome: "accept", content: { path: "/home/demo/projects", depth: 2 } });
  });

  test("edits project instructions through the agent's fs extensions", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Memory & project" }).click();
    await page.getByTestId("project-instructions").fill("# Rules\n\nBe brief.\n");
    await page.getByTestId("project-save").click();
    await expect(page.getByTestId("project-status")).toContainText("Saved");
    const writes = await waitForCalls(page, "x.ai/fs/write_file");
    expect(writes[0].params.path).toContain("AGENTS.md");
    expect(writes[0].params.content).toContain("Be brief.");
    const files = (await mock.state()).files as Record<string, string>;
    expect(Object.values(files).some((content) => content.includes("Be brief."))).toBe(true);
  });

  test("lists and toggles skills by topic, and browses memory", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    await page.getByRole("button", { name: "New chat" }).click();
    await waitForCalls(page, "session/new");
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Skills" }).click();
    // Topic groups for bundled skills; User still wraps user-scoped rows.
    await expect(page.getByTestId("skill-group-Game")).toContainText("Game (2)");
    await expect(page.getByTestId("skill-group-Documents")).toContainText("Documents (1)");
    await expect(page.getByTestId("skill-group-User")).toContainText("User (1)");
    await expect(page.getByTestId("skill-game-tilesets")).toContainText("Game tilesets");
    await expect(page.getByTestId("plugin-cook-core")).toContainText("1.0.0");
    await page.getByLabel("Toggle skill game-tilesets").click();
    const skillToggles = await waitForCalls(page, "x.ai/skills/toggle");
    // `SkillsListRequest.cwd` is a required field on the shell side, so it must always travel.
    expect(skillToggles[0].params).toMatchObject({ name: "game-tilesets", enabled: false, cwd: "/tmp/cook-demo" });
    expect(skillToggles[0].params).not.toHaveProperty("names");

    // Game is fully off; its switch enables every disabled member via sequential { name } calls.
    await expect(page.getByLabel("Toggle all Game")).toHaveAttribute("aria-checked", "false");
    await page.getByLabel("Toggle all Game").click();
    const reenabled = await waitForCalls(page, "x.ai/skills/toggle", 3);
    // Rows are label-sorted inside the group, so asset-core precedes tilesets.
    expect(reenabled[1].params).toMatchObject({ name: "game-asset-core", enabled: true, cwd: "/tmp/cook-demo" });
    expect(reenabled[1].params).not.toHaveProperty("names");
    expect(reenabled[2].params).toMatchObject({ name: "game-tilesets", enabled: true, cwd: "/tmp/cook-demo" });
    expect(reenabled[2].params).not.toHaveProperty("names");

    // Uniform again, so the same switch turns the whole category off with one call per name.
    await expect(page.getByLabel("Toggle all Game")).toHaveAttribute("aria-checked", "true");
    await page.getByLabel("Toggle all Game").click();
    const categoryOff = await waitForCalls(page, "x.ai/skills/toggle", 5);
    expect(categoryOff[3].params).toMatchObject({ name: "game-asset-core", enabled: false, cwd: "/tmp/cook-demo" });
    expect(categoryOff[4].params).toMatchObject({ name: "game-tilesets", enabled: false, cwd: "/tmp/cook-demo" });
    expect(categoryOff.every((entry) => !("names" in entry.params))).toBe(true);

    // The category header folds its rows without touching skill state.
    await expect(page.getByTestId("skill-group-Game").getByRole("button", { name: "Game (2)" })).toHaveAttribute("aria-expanded", "true");
    await page.getByTestId("skill-group-Game").getByRole("button", { name: "Game (2)" }).click();
    await expect(page.getByTestId("skill-game-tilesets")).toHaveCount(0);
    await page.getByTestId("skill-group-Game").getByRole("button", { name: "Game (2)" }).click();
    await expect(page.getByTestId("skill-game-tilesets")).toBeVisible();

    // Turn the category back on so the rest of this test starts from a known state.
    await page.getByLabel("Toggle all Game").click();
    await waitForCalls(page, "x.ai/skills/toggle", 7);

    const skillDescription = page.getByTestId("skill-game-tilesets").locator(".skill-description");
    await expect(skillDescription).toHaveAttribute("aria-expanded", "false");
    await skillDescription.click();
    await expect(skillDescription).toHaveAttribute("aria-expanded", "true");
    // The search box filters without dropping the topic groups that still match.
    await page.getByTestId("skill-search").fill("review");
    await expect(page.getByTestId("skill-game-tilesets")).toHaveCount(0);
    await expect(page.getByTestId("skill-review")).toBeVisible();
    await expect(page.getByTestId("skill-group-Game")).toHaveCount(0);
    await page.getByTestId("skill-search").fill("");
    await expect(page.getByTestId("skill-game-tilesets")).toBeVisible();
    await expect(page.getByTestId("plugins-reload")).toBeVisible();
    await expect(page.getByTestId("workflow-list")).toBeVisible();

    await page.getByRole("tab", { name: "Hooks" }).click();
    await expect(page.getByTestId("hooks-panel")).toBeVisible();
    await page.getByTestId("hooks-trust").click();
    await waitForCalls(page, "x.ai/hooks/action");

    await page.getByRole("tab", { name: "Memory & project" }).click();
    await page.getByTestId("memory-flush").click();
    await expect(page.getByTestId("memory-status")).toContainText("flush requested");
    await expect(page.getByTestId("memory-browser")).toBeVisible();
  });
});

test.describe("goal and plan presentation", () => {
  const composer = (page: Page) => page.getByPlaceholder("Ask Cook anything…");
  const PLAN_SEED = {
    ...CONNECTED_SEED,
    promptUpdates: [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Writing the plan." } },
      {
        sessionUpdate: "plan",
        entries: [
          { content: "Map the TUI goal surface", priority: "high", status: "completed" },
          { content: "Render the goal chip", priority: "high", status: "in_progress" },
          { content: "Add the completion marker", priority: "medium", status: "pending" },
          { content: "Drop the old approach", priority: "low", status: "completed", _meta: { cancelled: true } },
        ],
      },
    ],
  };

  test("paints plan entries with the todo pane's status glyphs", async ({ page }) => {
    await openWorkspace(page, PLAN_SEED);
    await composer(page).fill("show me the plan");
    await composer(page).press("Enter");

    await expect(page.getByText("Writing the plan.")).toBeVisible();
    await expect(page.locator(".plan-card")).toHaveCount(0);
    await expect(page.getByTestId("todo-overlay")).toHaveCount(0);
    await page.getByTestId("todo-toggle").click();
    const overlay = page.getByTestId("todo-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay.getByTestId("plan-entry-completed")).toContainText("Map the TUI goal surface");
    await expect(overlay.getByTestId("plan-entry-in_progress")).toContainText("Render the goal chip");
    await expect(overlay.getByTestId("plan-entry-pending")).toContainText("Add the completion marker");
    // ACP has no cancelled status, so the cancelled row only shows through `_meta.cancelled`.
    await expect(overlay.getByTestId("plan-entry-cancelled")).toContainText("Drop the old approach");

    // ACP Plan updates replace the list in place instead of appending a second card.
    await page.evaluate(() => window.__cookMock!.sessionNotification({
      sessionUpdate: "plan",
      entries: [{ content: "Render the goal chip", priority: "high", status: "completed" }],
    }));
    await expect(overlay.getByTestId("plan-entry-completed")).toHaveCount(1);
    await expect(page.getByTestId("todo-overlay")).toHaveCount(1);
  });

  test("keeps the plan pane in the transcript region and the composer enabled", async ({ page }) => {
    await openWorkspace(page, CONNECTED_SEED);
    await page.evaluate(() => window.__cookMock!.plan());

    const pane = page.getByTestId("plan-pane");
    const input = page.getByTestId("composer-input");
    await expect(pane).toBeVisible();
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("plan-notes")).toHaveCount(0);
    await expect(page.getByTestId("plan-comment-input")).toHaveCount(0);
    const paneBox = await pane.boundingBox();
    const inputBox = await input.boundingBox();
    const status = page.getByTestId("turn-status");
    const statusBox = (await status.count()) > 0 ? await status.boundingBox() : null;
    if (statusBox) {
      expect(paneBox!.y + paneBox!.height).toBeLessThanOrEqual(statusBox.y + 1);
      expect(inputBox!.y).toBeGreaterThanOrEqual(statusBox.y + statusBox.height - 1);
    } else {
      expect(paneBox!.y + paneBox!.height).toBeLessThanOrEqual(inputBox!.y + 1);
    }
  });

  test("uses the live composer for request changes without hiding the pane", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    const requestId = await page.evaluate(() => window.__cookMock!.plan());
    const input = page.getByTestId("composer-input");
    await expect(page.getByTestId("plan-pane")).toBeVisible();
    await expect(input).toHaveAttribute("placeholder", "Request changes…");
    await input.press("Enter");
    expect((await mock.responses()).find((entry) => entry.id === requestId)).toBeUndefined();
    await input.fill("split these into two steps");
    await input.press("Enter");
    await expect.poll(async () => (await mock.responses()).find((entry) => entry.id === requestId)?.result).toEqual({
      outcome: "cancelled",
      feedback: "split these into two steps",
    });
  });

  test("supports pane hide, chip reopen, and focus-only Escape", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    // Plan files belong to a session, and the session is created by the first prompt.
    await composer(page).fill("plan something");
    await composer(page).press("Enter");
    await expect(page.getByText("Mock assistant reply.")).toBeVisible();
    const requestId = await page.evaluate(() => window.__cookMock!.plan());
    await expect(page.getByTestId("plan-pane")).toContainText(PLAN_FILE);
    await page.getByTestId("dialog-hide").click();
    await expect(page.getByTestId("plan-pane")).toHaveCount(0);
    expect((await mock.responses()).find((entry) => entry.id === requestId)).toBeUndefined();
    // The chip opens the session's plan list; the current episode's row reopens the review pane.
    await page.getByTestId("plan-chip").click();
    await expect(page.getByTestId("plan-menu")).toBeVisible();
    await page.getByTestId(`plan-file-open-${PLAN_FILE}`).click();
    await expect(page.getByTestId("plan-pane")).toBeVisible();

    const input = page.getByTestId("composer-input");
    await input.click();
    await expect(input).toHaveAttribute("placeholder", "Request changes…");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("plan-pane")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("plan-pane")).toHaveCount(0);
    expect((await mock.responses()).find((entry) => entry.id === requestId)).toBeUndefined();
  });

  test("anchors a comment to dragged lines and sends it through the composer", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    const requestId = await page.evaluate(() => window.__cookMock!.plan());
    const first = await page.getByTestId("plan-line-3").boundingBox();
    const last = await page.getByTestId("plan-line-4").boundingBox();
    await page.mouse.move(first!.x + 60, first!.y + first!.height / 2);
    await page.mouse.down();
    await page.mouse.move(last!.x + 60, last!.y + last!.height / 2);
    await page.mouse.up();

    const input = page.getByTestId("composer-input");
    await expect(input).toHaveAttribute("placeholder", "Type your comment…");
    await expect(page.getByTestId("plan-pane")).toBeVisible();
    await input.fill("split these into two steps");
    await input.press("Enter");
    await expect(page.getByTestId("plan-comment-0")).toContainText("L3-4");
    await expect(page.getByTestId("plan-comment-badge")).toHaveText("1 ●");

    await page.getByTestId("plan-changes").click();
    await expect(input).toHaveAttribute("placeholder", "Request changes…");
    await input.press("Enter");
    await expect.poll(async () => (await mock.responses()).find((entry) => entry.id === requestId)?.result).toEqual({
      outcome: "cancelled",
      feedback: "Proposed plan lines 3-4:\n> 1. Update the transcript renderer\n> 2. Verify the desktop flow\n\nComment:\nsplit these into two steps",
    });
  });

  test("approves on empty a, but types a when the composer has text", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    const requestId = await page.evaluate(() => window.__cookMock!.plan());
    const input = page.getByTestId("composer-input");
    await input.click();
    await input.fill("keep");
    await input.press("a");
    await expect(input).toHaveValue("keepa");
    expect((await mock.responses()).find((entry) => entry.id === requestId)).toBeUndefined();
    await input.fill("");
    await input.press("a");
    await expect.poll(async () => (await mock.responses()).find((entry) => entry.id === requestId)?.result).toEqual({ outcome: "approved" });
  });

  test("queues a follow-up while a turn is running", async ({ page }) => {
    await openWorkspace(page, { ...CONNECTED_SEED, promptDelayMs: 250 });
    const input = page.getByTestId("composer-input");
    await input.fill("hello");
    await input.press("Enter");
    await expect(page.getByTestId("turn-status")).toBeVisible();
    await expect(input).toBeEnabled();
    await input.fill("follow up");
    await input.press("Enter");
    const prompts = await waitForCalls(page, "session/prompt", 2);
    expect((prompts.at(-1)?.params.prompt as Array<Record<string, unknown>>)).toEqual([{ type: "text", text: "follow up" }]);
    await expect(page.getByTestId("send-button")).toContainText("Queue");
  });

  test("shows an empty plan without an inline card and can quit it", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    const requestId = await page.evaluate(() => window.__cookMock!.plan({ planContent: null }));
    await expect(page.getByTestId("inline-interaction")).toHaveCount(0);
    const pane = page.getByTestId("plan-pane");
    await expect(pane).toContainText(`${PLAN_FILE} (empty)`);
    await expect(pane).toContainText("No plan written yet");
    await page.getByTestId("plan-quit").click();
    await expect(page.getByTestId("plan-pane")).toHaveCount(0);
    expect((await mock.responses()).find((entry) => entry.id === requestId)?.result).toEqual({ outcome: "abandoned" });
  });

  test("shows the goal chip, its detail surface and the end-to-end row", async ({ page }) => {
    await openWorkspace(page, CONNECTED_SEED);
    await composer(page).fill("start the goal");
    await composer(page).press("Enter");
    // A goal belongs to a session, so wait for the prompt to create one before the shell reports.
    await expect(page.locator(".session-event")).toBeVisible();

    await page.evaluate(() => window.__cookMock!.sessionNotification(window.__cookMock!.goalUpdate({
      token_budget: 100_000,
      tokens_used: 25_000,
      elapsed_ms: 65_000,
      current_subagent_role: "worker",
      total_worker_rounds: 4,
      total_verify_rounds: 2,
      live_subagent_tokens: 10_000,
      live_context_pct: 35,
      live_turn_count: 3,
      live_tool_call_count: 8,
      last_event: "worker_completed",
      last_event_detail: "Core logic",
      classifier_runs_attempted: 1,
      classifier_max_runs: 3,
      last_classifier_verdict: "not_achieved",
      last_classifier_details_path: "/tmp/details.md",
    })));

    await page.evaluate(() => window.__cookMock!.sessionNotification({
      sessionUpdate: "plan",
      entries: [
        { content: "Map the TUI goal surface", priority: "high", status: "completed" },
        { content: "Render the goal chip", priority: "high", status: "in_progress" },
      ],
    }));

    const chip = page.getByTestId("goal-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("Goal: Executing");
    await expect(chip).toContainText("/100k tokens");

    await chip.click();
    const detail = page.getByTestId("goal-detail");
    await expect(page.getByTestId("goal-detail-status")).toContainText("Active · Executing");
    await expect(detail).toContainText("Budget: 25k / 100k tokens (25%)");
    await expect(detail).toContainText(/Elapsed: 1m\d\ds/);
    // The goal's progress list is the session's plan, the same entries the todo pane holds.
    await expect(detail.getByTestId("plan-entry-in_progress")).toContainText("Render the goal chip");
    await expect(detail).toContainText("Active Subagent: worker (round 6)");
    await expect(detail).toContainText("Context: 35%");
    await expect(detail).toContainText("Last verdict: Not Achieved");
    await expect(detail).toContainText("Attempts: 1/3");
    await expect(detail).toContainText("Details: /tmp/details.md");
    await expect(detail).toContainText("Worker completed");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("goal-detail")).toHaveCount(0);

    await page.evaluate(() => window.__cookMock!.sessionNotification(window.__cookMock!.goalUpdate({ status: "complete", elapsed_ms: 619_000 })));
    await expect(chip).toContainText("Goal: Done");
    await expect(page.locator(".session-event", { hasText: "Goal complete" })).toHaveText("Goal complete in 10m19s end-to-end.");
  });

  test("labels the turn as verifying while the goal's completion is checked", async ({ page }) => {
    await openWorkspace(page, {
      ...CONNECTED_SEED,
      promptDelayMs: 1_500,
      promptUpdates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done with the work." } }],
    });
    await composer(page).fill("finish the goal");
    await page.getByTestId("send-button").click();
    await expect(page.getByTestId("turn-status")).toBeVisible();

    await page.evaluate(() => window.__cookMock!.sessionNotification(window.__cookMock!.goalUpdate({
      verifying_completion: true,
      classifier_runs_attempted: 1,
      classifier_max_runs: 3,
    })));
    await expect(page.getByTestId("turn-status")).toContainText("Verifying…");
    await expect(page.getByTestId("goal-chip")).toContainText("Goal: Verifying (1/3)");
  });

  test("shows a paused goal's resume hint and drops it once cleared", async ({ page }) => {
    await openWorkspace(page, CONNECTED_SEED);
    await page.evaluate(() => window.__cookMock!.sessionNotification(window.__cookMock!.goalUpdate({
      status: "user_paused",
      pause_message: "user",
      elapsed_ms: 30_000,
    })));
    const chip = page.getByTestId("goal-chip");
    await expect(chip).toContainText("Goal: Paused");
    await chip.click();
    await expect(page.getByTestId("goal-detail")).toContainText("Status: Paused. Type /goal resume to continue");
    await page.keyboard.press("Escape");

    await page.evaluate(() => window.__cookMock!.sessionNotification(window.__cookMock!.goalUpdate({ status: "cleared", goal_id: "" })));
    await expect(chip).toHaveCount(0);
  });
});

test.describe("session fork and export", () => {
  test("forks a sidebar session with camelCase params then loads the child", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openWorkspace(page, CONNECTED_SEED);

    const row = page.locator(".session-row", { hasText: "Fix login bug" });
    await row.hover();
    await row.getByTestId("session-menu-session-login").click();
    await row.getByTestId("session-fork-session-login").click();

    const forks = await waitForCalls(page, "x.ai/session/fork");
    expect(forks.at(-1)?.params).toMatchObject({
      sourceSessionId: "session-login",
      sourceCwd: "/tmp/cook-demo",
      newCwd: "/tmp/cook-demo",
      sessionKind: "fork",
    });
    expect(forks.at(-1)?.params).not.toHaveProperty("sessionId");

    const loaded = await waitForCalls(page, "session/load");
    expect(loaded.some((entry) => entry.params.sessionId === "fork-session-login")).toBe(true);
    await expect(page.locator(".session-row.active", { hasText: "Fix login bug (fork)" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("/fork from the composer uses the same RPC shape", async ({ page }) => {
    await openWorkspace(page, CONNECTED_SEED);
    await page.locator(".session-row", { hasText: "Fix login bug" }).getByRole("button").first().click();
    await waitForCalls(page, "session/load");

    await page.getByPlaceholder("Ask Cook anything…").fill("/fork");
    await page.getByTestId("send-button").click();

    const forks = await waitForCalls(page, "x.ai/session/fork");
    expect(forks.at(-1)?.params).toMatchObject({
      sourceSessionId: "session-login",
      sourceCwd: "/tmp/cook-demo",
      newCwd: "/tmp/cook-demo",
    });
    await waitForCalls(page, "session/load", 2);
  });
});

test.describe("conversation list", () => {
  /** Three conversations across two workspaces, newest first: alpha-new, beta, alpha-old. */
  const LIST_SEED = {
    ...CONNECTED_SEED,
    sessions: [
      { id: "s-alpha-new", title: "Alpha newest", cwd: "/Users/demo/projects/cook-demo", updatedAt: "2026-09-18T10:00:00Z" },
      { id: "s-beta", title: "Beta task", cwd: "/Users/demo/work/api-server", updatedAt: "2026-09-17T10:00:00Z" },
      { id: "s-alpha-old", title: "Alpha oldest", cwd: "/Users/demo/projects/cook-demo", updatedAt: "2026-09-10T10:00:00Z" },
    ],
  };

  function rowTitles(page: Page) {
    return page.locator(".session-row .session-open strong").allTextContents();
  }

  async function openRowMenu(page: Page, id: string) {
    const row = page.getByTestId(`session-row-${id}`);
    await row.hover();
    await row.getByTestId(`session-menu-${id}`).click();
    await expect(row.getByRole("menu")).toBeVisible();
    return row;
  }

  /**
   * Press a row's title, carry it to another row's upper or lower half, release. Returns the source
   * and target class attributes sampled while the row was still carried, so callers can assert the
   * in-flight affordances. Reordering runs on pointer events (the desktop shell swallows HTML5
   * drags for its file-drop handler), so this drives the mouse rather than `dragTo`.
   */
  async function dragRow(page: Page, fromId: string, toId: string, position: "before" | "after" = "after") {
    const source = (await page.getByTestId(`session-row-${fromId}`).boundingBox())!;
    const target = (await page.getByTestId(`session-row-${toId}`).boundingBox())!;
    const x = source.x + Math.min(60, source.width / 2);
    const y = source.y + source.height / 2;
    const dropY = position === "before" ? target.y + 4 : target.y + target.height - 4;
    await page.mouse.move(x, y);
    await page.mouse.down();
    // Clear the 4px threshold first, so the press reads as a reorder rather than a click.
    await page.mouse.move(x, y + 12, { steps: 3 });
    await page.mouse.move(x, dropY, { steps: 8 });
    const midDrag = {
      source: (await page.getByTestId(`session-row-${fromId}`).getAttribute("class")) ?? "",
      target: (await page.getByTestId(`session-row-${toId}`).getAttribute("class")) ?? "",
    };
    await page.mouse.up();
    return midDrag;
  }

  test("folds the row actions into one menu and pins a conversation across reloads", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openWorkspace(page, LIST_SEED);

    // The four hover icons are gone; each row carries one overflow trigger instead.
    await expect(page.getByTestId("session-fork-s-alpha-old")).toHaveCount(0);
    await expect(page.locator(".session-menu-trigger")).toHaveCount(3);

    const row = await openRowMenu(page, "s-alpha-old");
    const menu = row.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveText(["Pin to top", "Rename", "Fork", "Export", "Delete"]);

    // Delete reads as the light red danger tone; the other actions stay grey.
    const [danger, plain] = await Promise.all([
      menu.getByTestId("session-delete-s-alpha-old").evaluate((node) => getComputedStyle(node).color),
      menu.getByTestId("session-rename-s-alpha-old").evaluate((node) => getComputedStyle(node).color),
    ]);
    expect(danger).toBe("rgb(244, 135, 113)");
    expect(plain).not.toBe(danger);

    await menu.getByTestId("session-pin-s-alpha-old").click();
    await expect(row).toHaveAttribute("data-pinned", "true");
    await expect(page.locator(".session-group-heading span")).toHaveText(["Pinned"]);
    expect(await rowTitles(page)).toEqual(["Alpha oldest", "Alpha newest", "Beta task"]);

    await page.reload();
    await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
    await expect(page.getByTestId("session-row-s-alpha-old")).toHaveAttribute("data-pinned", "true");
    expect(await rowTitles(page)).toEqual(["Alpha oldest", "Alpha newest", "Beta task"]);

    // The same menu unpins, and the pinned block disappears with it.
    const reopened = await openRowMenu(page, "s-alpha-old");
    await reopened.getByTestId("session-pin-s-alpha-old").click();
    await expect(page.getByTestId("session-row-s-alpha-old")).toHaveAttribute("data-pinned", "false");
    await expect(page.locator(".session-group-heading")).toHaveCount(0);
    expect(await rowTitles(page)).toEqual(["Alpha newest", "Beta task", "Alpha oldest"]);
    expect(errors).toEqual([]);
  });

  test("sorts by time by default and by workspace on request", async ({ page }) => {
    await openWorkspace(page, LIST_SEED);

    await expect(page.getByTestId("conversation-sort")).toContainText("Time");
    await expect(page.locator(".session-group-heading")).toHaveCount(0);
    expect(await rowTitles(page)).toEqual(["Alpha newest", "Beta task", "Alpha oldest"]);

    await page.getByTestId("conversation-sort").click();
    await page.getByTestId("sort-workspace").click();
    await expect(page.getByTestId("conversation-sort")).toContainText("Workspace");

    // One block per workspace, most recently used first, newest conversation on top inside each.
    await expect(page.locator(".session-group-heading span")).toHaveText(["cook-demo", "api-server"]);
    await expect(page.locator(".session-group-heading small")).toHaveText(["2", "1"]);
    expect(await rowTitles(page)).toEqual(["Alpha newest", "Alpha oldest", "Beta task"]);

    await page.reload();
    await expect(page.getByTestId("conversation-sort")).toContainText("Workspace");
    await expect(page.locator(".session-group-heading span")).toHaveText(["cook-demo", "api-server"]);
  });

  test("reorders conversations by dragging a row", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openWorkspace(page, LIST_SEED);
    expect(await rowTitles(page)).toEqual(["Alpha newest", "Beta task", "Alpha oldest"]);

    // While a row is carried over another one, both paint their affordance: the source dims and
    // the target shows which half the drop will land on.
    const carried = await dragRow(page, "s-alpha-old", "s-alpha-new", "before");
    expect(carried.source).toContain("dragging");
    expect(carried.target).toContain("drop-before");
    expect(await rowTitles(page)).toEqual(["Alpha oldest", "Alpha newest", "Beta task"]);
    await expect(page.getByTestId("session-row-s-alpha-new")).not.toHaveClass(/drop-before/);
    // Releasing after a reorder must not also open the conversation that was carried.
    expect(await callsTo(await api(page).requests(), "session/load")).toHaveLength(0);

    // The arrangement survives a reload, and the sort menu offers a way back to plain recency.
    await page.reload();
    await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
    expect(await rowTitles(page)).toEqual(["Alpha oldest", "Alpha newest", "Beta task"]);

    await page.getByTestId("conversation-sort").click();
    await page.getByTestId("sort-reset-order").click();
    expect(await rowTitles(page)).toEqual(["Alpha newest", "Beta task", "Alpha oldest"]);

    // A plain click still opens a conversation, and the press that carried a row is not one.
    await page.getByTestId("session-row-s-beta").locator(".session-open").click();
    await waitForCalls(page, "session/load");
    await expect(page.getByTestId("session-row-s-beta")).toHaveClass(/active/);
    expect(await rowTitles(page)).toEqual(["Alpha newest", "Beta task", "Alpha oldest"]);
    expect(errors).toEqual([]);
  });

  test("reorders inside a workspace block and refuses drops across blocks", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openWorkspace(page, LIST_SEED);
    await page.getByTestId("conversation-sort").click();
    await page.getByTestId("sort-workspace").click();
    expect(await rowTitles(page)).toEqual(["Alpha newest", "Alpha oldest", "Beta task"]);

    // A cross-workspace drop would silently move a conversation to another folder, so it is ignored.
    const refused = await dragRow(page, "s-beta", "s-alpha-new", "before");
    expect(refused.source).toContain("dragging");
    expect(refused.target).not.toContain("drop-");
    expect(await rowTitles(page)).toEqual(["Alpha newest", "Alpha oldest", "Beta task"]);

    await dragRow(page, "s-alpha-old", "s-alpha-new", "before");
    expect(await rowTitles(page)).toEqual(["Alpha oldest", "Alpha newest", "Beta task"]);

    await page.reload();
    await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
    expect(await rowTitles(page)).toEqual(["Alpha oldest", "Alpha newest", "Beta task"]);
    expect(errors).toEqual([]);
  });

  test("shows the running turn on the conversation the agent is working in", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Hold the prompt response open so the turn stays live long enough to inspect.
    await openWorkspace(page, { ...LIST_SEED, promptDelayMs: 3000 });

    // Idle rows carry workspace and date, and no row shows a status yet.
    await expect(page.getByTestId("session-turn-status")).toHaveCount(0);
    await expect(page.getByTestId("session-row-s-beta").locator(".session-date")).toBeVisible();

    await page.getByTestId("session-row-s-alpha-new").locator(".session-open").click();
    await waitForCalls(page, "session/load");
    await page.getByPlaceholder("Ask Cook anything…").fill("summarise the repo");
    await page.getByTestId("send-button").click();
    await waitForCalls(page, "session/prompt");

    const status = page.getByTestId("session-row-s-alpha-new").getByTestId("session-turn-status");
    await expect(status).toBeVisible();
    await expect(status).toContainText("Responding");
    await expect(status).toHaveAttribute("data-live", "true");
    await expect(status.locator(".session-turn-timer")).toHaveText(/\d/);
    // The workspace path stays on the line; the status sits to its right in place of the date.
    const working = page.getByTestId("session-row-s-alpha-new");
    await expect(working.locator(".session-workspace-name")).toHaveText("cook-demo");
    await expect(working.locator(".session-date")).toHaveCount(0);
    expect((await status.boundingBox())!.x).toBeGreaterThan((await working.locator(".session-path").boundingBox())!.x);
    // Only the working conversation is annotated: the rest keep their metadata line.
    await expect(page.getByTestId("session-turn-status")).toHaveCount(1);
    await expect(page.getByTestId("session-row-s-beta").locator(".session-date")).toBeVisible();

    // The status clears once the turn ends.
    await expect(page.getByTestId("session-row-s-alpha-new").getByTestId("session-turn-status")).toHaveCount(0);
    await expect(page.getByTestId("session-row-s-alpha-new").locator(".session-date")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("shows the turn for a new chat the agent has not listed yet", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openWorkspace(page, { ...LIST_SEED, promptDelayMs: 3000 });
    expect(await rowTitles(page)).toEqual(["Alpha newest", "Beta task", "Alpha oldest"]);

    // `session/new` reports an id the seeded list does not know, so the row is the window's own.
    await page.getByRole("button", { name: "New chat" }).click();
    const open = page.locator(".session-row.active");
    await expect(open).toHaveCount(1);
    await expect(open.locator(".session-open strong")).toHaveText("Untitled conversation");
    await expect(open.locator(".session-workspace-name")).toBeVisible();
    await expect(page.getByTestId("session-turn-status")).toHaveCount(0);

    await page.getByPlaceholder("Ask Cook anything…").fill("start from scratch");
    await page.getByTestId("send-button").click();
    await waitForCalls(page, "session/prompt");

    // The working conversation reports from the list without having been picked out of it.
    await expect(open.getByTestId("session-turn-status")).toHaveAttribute("data-live", "true");
    await expect(open.getByTestId("session-turn-status")).toContainText("Responding");
    expect(await rowTitles(page)).toHaveLength(4);
    // The conversation list keeps the conversations the agent does report.
    for (const id of ["s-alpha-new", "s-beta", "s-alpha-old"]) {
      await expect(page.getByTestId(`session-row-${id}`)).toBeVisible();
    }
    expect(errors).toEqual([]);
  });

  test("keeps the turn visible in the list after opening another conversation", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openWorkspace(page, { ...LIST_SEED, promptDelayMs: 3000 });

    await page.getByTestId("session-row-s-alpha-new").locator(".session-open").click();
    await waitForCalls(page, "session/load");
    await page.getByPlaceholder("Ask Cook anything…").fill("hold this turn open");
    await page.getByTestId("send-button").click();
    await waitForCalls(page, "session/prompt");
    const working = page.getByTestId("session-row-s-alpha-new").getByTestId("session-turn-status");
    await expect(working).toHaveAttribute("data-live", "true");

    // Opening another conversation must not drop the row that is still working, and the row keeps
    // the phase that conversation last reported instead of flattening to a generic wait.
    await page.getByTestId("session-row-s-beta").locator(".session-open").click();
    await waitForCalls(page, "session/load", 2);
    await expect(page.getByTestId("session-row-s-beta")).toHaveClass(/active/);
    await expect(working).toHaveAttribute("data-live", "false");
    await expect(working).toContainText("Responding…");
    await expect(page.getByTestId("session-row-s-alpha-new").locator(".session-workspace-name")).toHaveText("cook-demo");
    await expect(page.getByTestId("session-row-s-beta").getByTestId("session-turn-status")).toHaveCount(0);
    await expect(page.getByTestId("session-row-s-beta").locator(".session-date")).toBeVisible();

    // Switching back keeps the turn state, and the turn still ends on its own.
    await page.getByTestId("session-row-s-alpha-new").locator(".session-open").click();
    await waitForCalls(page, "session/load", 3);
    await expect(working).toHaveAttribute("data-live", "true");
    await expect(page.getByTestId("session-row-s-alpha-new").getByTestId("session-turn-status")).toHaveCount(0);
    await expect(page.getByTestId("session-row-s-alpha-new").locator(".session-date")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("marks the conversation as blocked while the agent waits for an answer", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openWorkspace(page, { ...LIST_SEED, promptDelayMs: 10_000 });

    await page.getByTestId("session-row-s-alpha-new").locator(".session-open").click();
    await waitForCalls(page, "session/load");
    await page.getByPlaceholder("Ask Cook anything…").fill("ship the sidebar");
    await page.getByTestId("send-button").click();
    await waitForCalls(page, "session/prompt");

    const status = page.getByTestId("session-row-s-alpha-new").getByTestId("session-turn-status");
    await expect(status.locator(".session-turn-spinner")).not.toHaveClass(/blocked/);

    // An open ask card is the agent waiting on the user, which the TUI paints as a diamond.
    await page.evaluate(() => void window.__cookMock!.question());
    await expect(status.locator(".session-turn-spinner")).toHaveText("◆");
    await expect(status.locator(".session-turn-spinner")).toHaveClass(/blocked/);
    await expect(status).toContainText("Waiting on answers for");
    // The chat's own activity row reports the same phase.
    await expect(page.getByTestId("turn-status").locator(".turn-status-spinner")).toHaveText("◆");
    expect(errors).toEqual([]);
  });

  test("keeps the composer usable after opening another conversation mid-turn", async ({ page }) => {
    const mock = api(page);
    // Long enough that the first turn is certainly still in flight when the second one is sent.
    await openWorkspace(page, { ...LIST_SEED, promptDelayMs: 20_000 });

    await page.getByTestId("session-row-s-alpha-new").locator(".session-open").click();
    await waitForCalls(page, "session/load");
    await page.getByPlaceholder("Ask Cook anything…").fill("hold this turn open");
    await page.getByTestId("send-button").click();
    await waitForCalls(page, "session/prompt");

    // The turn in the first conversation must not block the second one: the outstanding prompt
    // belongs to a conversation the composer is no longer showing.
    await page.getByTestId("session-row-s-beta").locator(".session-open").click();
    await waitForCalls(page, "session/load", 2);
    await page.getByPlaceholder("Ask Cook anything…").fill("work in parallel");
    await expect(page.getByTestId("send-button")).toBeEnabled();
    await page.getByTestId("send-button").click();
    await expect
      .poll(async () => callsTo(await mock.requests(), "session/prompt").length)
      .toBeGreaterThanOrEqual(2);
    const prompts = callsTo(await mock.requests(), "session/prompt");
    expect(prompts.at(-1)?.params.sessionId).toBe("s-beta");

    // Both conversations report their turn in the list.
    await expect(page.getByTestId("session-row-s-alpha-new").getByTestId("session-turn-status")).toBeVisible();
    await expect(page.getByTestId("session-row-s-beta").getByTestId("session-turn-status")).toBeVisible();
  });

  test("keeps a background conversation's phase moving as its updates arrive", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openWorkspace(page, { ...LIST_SEED, promptDelayMs: 20_000 });

    await page.getByTestId("session-row-s-alpha-new").locator(".session-open").click();
    await waitForCalls(page, "session/load");
    await page.getByPlaceholder("Ask Cook anything…").fill("hold this turn open");
    await page.getByTestId("send-button").click();
    await waitForCalls(page, "session/prompt");

    const working = page.getByTestId("session-row-s-alpha-new").getByTestId("session-turn-status");
    await expect(working).toContainText("Responding…");

    await page.getByTestId("session-row-s-beta").locator(".session-open").click();
    await waitForCalls(page, "session/load", 2);
    await expect(working).toHaveAttribute("data-live", "false");
    await expect(working).toContainText("Responding…");

    // The agent keeps streaming for the conversation that is no longer on screen; those updates
    // still move its row, so the list never reports a phase the turn has already left.
    await page.evaluate(() => window.__cookMock!.sessionNotification({
      sessionUpdate: "tool_call",
      toolCallId: "tc-bg",
      title: "execute",
      status: "pending",
      rawInput: { command: "pnpm build" },
    }, "s-alpha-new"));
    await expect(working).toContainText("Run pnpm build");
    await expect(working).toHaveAttribute("data-live", "false");
    expect(errors).toEqual([]);
  });

  test("keeps one clock for a conversation the window leaves and reopens mid-turn", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openWorkspace(page, { ...LIST_SEED, promptDelayMs: 20_000 });
    // `formatDuration` reads back as seconds while a turn is well under a minute: `4.7s`, `45s`.
    const seconds = async (locator: Locator) => Number.parseFloat((await locator.textContent())!.replace("s", ""));

    await page.getByTestId("session-row-s-alpha-new").locator(".session-open").click();
    await waitForCalls(page, "session/load");
    await page.getByPlaceholder("Ask Cook anything…").fill("hold this turn open");
    await page.getByTestId("send-button").click();
    await waitForCalls(page, "session/prompt");

    const row = page.getByTestId("session-row-s-alpha-new");
    const chatTimer = page.getByTestId("turn-status").locator(".turn-status-timer");
    const rowTimer = row.locator(".session-turn-timer");
    await expect(chatTimer).toBeVisible();
    // The list and the chat's own row time the same turn from the same start.
    expect(Math.abs(await seconds(chatTimer) - await seconds(rowTimer))).toBeLessThanOrEqual(0.3);

    // In the background the list keeps counting on its own.
    await page.getByTestId("session-row-s-beta").locator(".session-open").click();
    await waitForCalls(page, "session/load", 2);
    const background = await seconds(rowTimer);
    await expect.poll(async () => seconds(rowTimer)).toBeGreaterThan(background + 0.5);

    // Reopening the conversation resumes that clock and that phase, and writes no turn marker for
    // a turn that is still running.
    await row.locator(".session-open").click();
    await waitForCalls(page, "session/load", 3);
    await expect(chatTimer).toBeVisible();
    await expect(page.getByTestId("turn-status")).toContainText("Responding…");
    await expect(row.getByTestId("session-turn-status")).toContainText("Responding…");
    expect(Math.abs(await seconds(chatTimer) - await seconds(rowTimer))).toBeLessThanOrEqual(0.3);
    await expect(page.locator(".session-event")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("resizes the sidebar by dragging the edge and remembers the width", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openWorkspace(page, LIST_SEED);
    const sidebar = page.locator(".sidebar");
    const startWidth = Math.round((await sidebar.boundingBox())!.width);

    const handle = (await page.getByTestId("sidebar-resizer").boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 120);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 120, handle.y + 120, { steps: 10 });
    await page.mouse.up();

    const widened = Math.round((await sidebar.boundingBox())!.width);
    expect(widened).toBeGreaterThan(startWidth + 100);
    expect((await page.getByTestId("sidebar-resizer").getAttribute("aria-valuenow"))).toBe(String(widened));
    // Nothing overflows the window, and the conversation rows keep their metadata line.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("session-row-s-beta").locator(".session-date")).toBeVisible();

    // The width is remembered across a reload.
    await page.reload();
    await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
    expect(Math.round((await sidebar.boundingBox())!.width)).toBe(widened);

    // Dragging far past the maximum clamps instead of squeezing the chat away.
    const far = (await page.getByTestId("sidebar-resizer").boundingBox())!;
    await page.mouse.move(far.x + far.width / 2, far.y + 120);
    await page.mouse.down();
    await page.mouse.move(far.x + 2000, far.y + 120, { steps: 10 });
    await page.mouse.up();
    expect(Math.round((await sidebar.boundingBox())!.width)).toBe(440);

    // Arrow keys step the width, and a double click returns to the stylesheet default.
    await page.getByTestId("sidebar-resizer").focus();
    await page.keyboard.press("ArrowLeft");
    expect(Math.round((await sidebar.boundingBox())!.width)).toBe(440 - 16);
    await page.getByTestId("sidebar-resizer").dblclick();
    expect(Math.round((await sidebar.boundingBox())!.width)).toBe(startWidth);
    await page.reload();
    await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
    expect(Math.round((await sidebar.boundingBox())!.width)).toBe(startWidth);
    expect(errors).toEqual([]);
  });
});

test.describe("minimum window", () => {
  // `src-tauri/tauri.conf.json` pins the window to minWidth 840 / minHeight 600.
  test.use({ viewport: { width: 840, height: 600 } });

  test("keeps the composer, palette and providers usable", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openWorkspace(page, CONNECTED_SEED);

    await expect(page.getByPlaceholder("Ask Cook anything…")).toBeVisible();
    await expect(page.getByTestId("send-button")).toBeVisible();

    // The slash menu opens upward from the composer, so the pinned minimum height must hold it.
    await page.getByPlaceholder("Ask Cook anything…").fill("/");
    await expect(page.getByTestId("slash-item-plan")).toBeVisible();
    const menu = await page.getByTestId("slash-menu").boundingBox();
    expect(menu!.y).toBeGreaterThanOrEqual(0);
    expect(menu!.y + menu!.height).toBeLessThanOrEqual(600);
    // The info line ends before the send button rather than running under it.
    const info = await page.getByTestId("composer-info").boundingBox();
    const send = await page.getByTestId("send-button").boundingBox();
    expect(info!.x + info!.width).toBeLessThanOrEqual(send!.x);
    await page.getByPlaceholder("Ask Cook anything…").fill("");

    await page.getByPlaceholder("Ask Cook anything…").fill("minimum window turn");
    await page.getByTestId("send-button").click();
    await expect(page.getByText("Mock assistant reply.")).toBeVisible();
    await waitForCalls(page, "session/prompt");

    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Models" }).click();
    await expect(page.getByTestId("provider-row-openai")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
    await page.getByLabel("Settings").click();
    await page.keyboard.press("Meta+w");
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });

  test("activity panel lists backgrounded tasks and kill calls x.ai/task/kill", async ({ page }) => {
    await openWorkspace(page, CONNECTED_SEED);
    await page.getByRole("button", { name: "New chat" }).click();
    await page.getByLabel("Open tools panel").click();
    await expect(page.getByTestId("utility-panel")).toBeVisible();
    await page.getByTestId("utility-panel").getByRole("button", { name: /^Activity/ }).click();
    await expect(page.getByTestId("activity-view")).toBeVisible();

    await page.evaluate(() => window.__cookMock!.taskBackgrounded({
      task_id: "bg-e2e",
      description: "Integration sleep",
      command: "sleep 60",
    }));
    await expect(page.getByTestId("activity-row-bg-e2e")).toBeVisible();
    await expect(page.getByTestId("activity-row-bg-e2e")).toContainText("Integration sleep");
    await expect(page.getByTestId("activity-row-bg-e2e")).toHaveAttribute("data-status", "running");

    await page.getByTestId("activity-kill-bg-e2e").click();
    await expect.poll(async () => {
      const requests = await api(page).requests();
      return callsTo(requests, "x.ai/task/kill").some((entry) => entry.params.taskId === "bg-e2e");
    }).toBe(true);
    await expect(page.getByTestId("activity-row-bg-e2e")).toHaveAttribute("data-status", "killed");
  });
});
