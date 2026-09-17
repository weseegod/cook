import { expect, test, type Page } from "@playwright/test";
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

type Recorded = { method: string; params: Record<string, unknown>; at: number };

function api(page: Page) {
  return {
    requests: (): Promise<Recorded[]> => page.evaluate(() => window.__thanhMock!.requests()),
    state: (): Promise<Record<string, unknown>> =>
      page.evaluate(() => window.__thanhMock!.state() as unknown as Record<string, unknown>),
    responses: (): Promise<Array<{ id: number | string; result: unknown }>> =>
      page.evaluate(() => window.__thanhMock!.responses()),
    elicit: (overrides?: Record<string, unknown>) =>
      page.evaluate((value) => window.__thanhMock!.elicit(value ?? {}), overrides ?? {}),
    modelsUpdate: (params?: Record<string, unknown>) =>
      page.evaluate((value) => window.__thanhMock!.modelsUpdate(value ?? {}), params ?? {}),
  };
}

/** Load the app with a seeded agent state, then open the workspace. */
async function openWorkspace(page: Page, seed: Record<string, unknown> = {}) {
  await seedAgent(page, seed);
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.waitForFunction(() => Boolean(window.__thanhMock));
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
  await page.getByPlaceholder("Ask Thanh anything…").evaluate((node, payload) => {
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
    // The agent holds the key; what comes back out is only a hint.
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Models" }).click();
    await expect(page.getByTestId("provider-row-deepseek")).toContainText("sk-l…abcd");
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
    await expect(page.getByTestId("provider-row-openai")).toContainText("sk-m…cdef");
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

    await page.getByPlaceholder("Ask Thanh anything…").fill("What changed?");
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
    await expect(row).toContainText("sk-m…cdef");
    await page.getByTestId("provider-edit-openai").click();
    const editor = page.getByRole("dialog", { name: "Edit OpenAI" });
    await expect(editor.getByText("Current key:")).toContainText("sk-m…cdef");
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
    await page.getByPlaceholder("Ask Thanh anything…").fill("what is in this image?");
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
    await page.getByPlaceholder("Ask Thanh anything…").fill("dropped this in");
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
    await page.getByPlaceholder("Ask Thanh anything…").fill("pasted this");
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
    await openWorkspace(page, { ...CONNECTED_SEED, pickedFiles: ["/tmp/thanh-demo/report.pdf"] });
    await page.getByTestId("attach-button").click();
    await expect(page.getByTestId("attachment-row")).toContainText("report.pdf");
    await page.getByPlaceholder("Ask Thanh anything…").fill("summarise this");
    await page.getByTestId("send-button").click();
    await expect(page.getByText("Mock assistant reply.")).toBeVisible();
    const parts = (await waitForCalls(page, "session/prompt"))[0].params.prompt as Array<Record<string, unknown>>;
    expect(parts.find((part) => part.type === "resource_link")).toMatchObject({
      name: "report.pdf",
      uri: "file:///tmp/thanh-demo/report.pdf",
    });
    expect(JSON.stringify(parts)).toContain("read_file");
    expect(JSON.stringify(parts)).not.toContain("base64");
  });

  test("reads a picked image inline as an image part", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, {
      ...CONNECTED_SEED,
      pickedFiles: ["/tmp/thanh-demo/diagram.png"],
      filePayloads: { "/tmp/thanh-demo/diagram.png": { data: PNG_BASE64, mediaType: "image/png", size: 70 } },
    });
    await page.getByTestId("attach-button").click();
    await expect(page.getByTestId("attachment-row")).toContainText("diagram.png");
    await page.getByPlaceholder("Ask Thanh anything…").fill("describe this diagram");
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
    await expect(page.getByPlaceholder("Ask Thanh anything…")).toHaveValue("/goal ");

    // Settings is reachable from the palette too.
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("settings");
    await page.getByTestId("palette-item-action-settings").click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("slash commands", () => {
  const composer = (page: Page) => page.getByPlaceholder("Ask Thanh anything…");
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
    expect(toggles[0].params).toMatchObject({ serverName: "filesystem", enabled: false });

    // Adding a connector is an `x.ai/mcp/upsert` request as well.
    await page.getByTestId("connector-add").click();
    await page.getByLabel("Connector name").fill("github");
    await page.getByLabel("Connector command").fill("npx");
    await page.getByLabel("Connector arguments").fill("-y @modelcontextprotocol/server-github");
    await page.getByTestId("connector-save").click();
    await expect(page.getByTestId("connector-github")).toContainText("npx");
    const upsert = await waitForCalls(page, "x.ai/mcp/upsert");
    expect(upsert[0].params).toMatchObject({
      serverName: "github",
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
      serverName: "linear-http",
      type: "http",
      url: "https://mcp.example.com/sse",
    });
    expect(errors).toEqual([]);
  });
});

test.describe("agent-driven surfaces", () => {
  test("answers an MCP elicitation in the interaction modal", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    const requestId = await mock.elicit();
    await expect(page.getByTestId("elicit-fields")).toBeVisible();
    await expect(page.getByTestId("elicit-accept")).toBeDisabled();
    await page.getByTestId("elicit-path").fill("/home/thanh/projects");
    await page.getByTestId("elicit-depth").fill("2");
    await page.getByTestId("elicit-accept").click();
    await expect(page.getByTestId("elicit-fields")).toHaveCount(0);
    const answer = (await mock.responses()).find((entry) => entry.id === requestId);
    expect(answer?.result).toEqual({ outcome: "accept", content: { path: "/home/thanh/projects", depth: 2 } });
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

  test("lists and toggles skills, and browses memory", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Skills" }).click();
    await expect(page.getByTestId("skill-help")).toBeVisible();
    await expect(page.getByTestId("plugin-thanh-core")).toContainText("1.0.0");
    await page.getByLabel("Toggle skill help").click();
    await waitForCalls(page, "x.ai/skills/toggle");
    const skillDescription = page.getByTestId("skill-help").locator(".skill-description");
    await expect(skillDescription).toHaveAttribute("aria-expanded", "false");
    await skillDescription.click();
    await expect(skillDescription).toHaveAttribute("aria-expanded", "true");

    await page.getByRole("tab", { name: "Memory & project" }).click();
    await page.getByTestId("memory-flush").click();
    await expect(page.getByTestId("memory-status")).toContainText("flush requested");
  });
});

test.describe("goal and plan presentation", () => {
  const composer = (page: Page) => page.getByPlaceholder("Ask Thanh anything…");
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
    await page.evaluate(() => window.__thanhMock!.sessionNotification({
      sessionUpdate: "plan",
      entries: [{ content: "Render the goal chip", priority: "high", status: "completed" }],
    }));
    await expect(overlay.getByTestId("plan-entry-completed")).toHaveCount(1);
    await expect(page.getByTestId("todo-overlay")).toHaveCount(1);
  });

  test("offers run-as-goal on the plan review", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    const requestId = await page.evaluate(() => window.__thanhMock!.plan());
    // PlanDialog auto-opens; verdicts live on its decision bar.
    await expect(page.getByRole("dialog")).toContainText("plan.md");
    await expect(page.getByTestId("inline-interaction")).toHaveCount(0);

    await page.getByTestId("plan-goal").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const answer = (await mock.responses()).find((entry) => entry.id === requestId);
    expect(answer?.result).toEqual({ outcome: "approved_as_goal" });
  });

  test("keeps the composer live during a plan review and sends typed feedback as request changes", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    const requestId = await page.evaluate(() => window.__thanhMock!.plan());
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByTestId("inline-interaction")).toHaveCount(0);
    await page.getByTestId("dialog-hide").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // The TUI's parked review keeps its prompt slot (`PlanApprovalFocus::Prompt`).
    await expect(page.locator(".prompt-slot")).toBeVisible();

    const input = page.getByTestId("composer-input");
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled();
    await expect(input).toHaveAttribute("placeholder", "Request changes…");

    // Empty `Enter` answers nothing (`empty_enter_on_revise_prompt_does_not_approve`).
    await input.press("Enter");
    expect((await mock.responses()).find((entry) => entry.id === requestId)).toBeUndefined();
    await expect(page.getByTestId("plan-chip")).toBeVisible();

    await input.fill("split these into two steps");
    await expect(input).toHaveValue("split these into two steps");
    await page.getByTestId("send-button").click();
    await expect.poll(async () => (await mock.responses()).find((entry) => entry.id === requestId)?.result).toEqual({
      outcome: "cancelled",
      feedback: "split these into two steps",
    });
  });

  test("opens the plan from the chip and hides without deciding", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    await page.evaluate(() => window.__thanhMock!.sessionNotification({
      sessionUpdate: "plan",
      entries: [{ content: "Update the transcript renderer", status: "pending" }],
    }));
    const requestId = await page.evaluate(() => window.__thanhMock!.plan());

    // Auto-open on exit_plan_mode; chip reopens after hide.
    await expect(page.getByTestId("plan-chip")).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText("plan.md");
    await expect(page.getByTestId("plan-line-1")).toContainText("Implementation plan");
    await expect(page.getByTestId("plan-line-3")).toContainText("Update the transcript renderer");
    for (const id of ["plan-approve", "plan-goal", "plan-changes", "plan-comment", "plan-copy", "plan-quit"]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }

    // The minimize dash hides the surface; it is not a close button and sends no verdict.
    await page.getByTestId("dialog-hide").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await mock.responses()).find((entry) => entry.id === requestId)).toBeUndefined();
    await expect(page.getByTestId("inline-interaction")).toHaveCount(0);

    await page.getByTestId("plan-chip").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    // Escape hides the surface too, and still answers nothing.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await mock.responses()).find((entry) => entry.id === requestId)).toBeUndefined();
    await page.getByTestId("plan-chip").click();
    await expect(page.getByTestId("plan-line-1")).toBeVisible();
  });

  test("anchors a comment to the dragged lines and sends them with request changes", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    const requestId = await page.evaluate(() => window.__thanhMock!.plan());
    await expect(page.getByRole("dialog")).toBeVisible();

    const first = await page.getByTestId("plan-line-3").boundingBox();
    const last = await page.getByTestId("plan-line-4").boundingBox();
    await page.mouse.move(first!.x + 60, first!.y + first!.height / 2);
    await page.mouse.down();
    await page.mouse.move(last!.x + 60, last!.y + last!.height / 2);
    await page.mouse.up();

    const input = page.getByTestId("plan-comment-input");
    await expect(input).toBeVisible();
    await input.fill("split these into two steps");
    await input.press("Enter");
    await expect(page.getByTestId("plan-comment-0")).toContainText("L3-4");
    await expect(page.getByTestId("plan-comment-badge")).toHaveText("1 ●");

    await page.getByTestId("plan-changes").click();
    await expect(page.getByTestId("plan-notes")).toBeVisible();
    await page.getByTestId("plan-notes").press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const answer = (await mock.responses()).find((entry) => entry.id === requestId);
    expect(answer?.result).toEqual({
      outcome: "cancelled",
      feedback: "Proposed plan lines 3-4:\n> 1. Update the transcript renderer\n> 2. Verify the desktop flow\n\nComment:\nsplit these into two steps",
    });
  });

  test("approves from the popup with a key and keeps the plan reachable", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    const requestId = await page.evaluate(() => window.__thanhMock!.plan());
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("a");

    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await mock.responses()).find((entry) => entry.id === requestId)?.result).toEqual({ outcome: "approved" });
    // The review is answered, so the verdict buttons are gone rather than dead.
    await expect(page.getByTestId("plan-chip")).toBeVisible();
    await page.getByTestId("plan-chip").click();
    await expect(page.getByTestId("plan-comment")).toBeVisible();
    await expect(page.getByTestId("plan-copy")).toBeVisible();
    await expect(page.getByTestId("plan-approve")).toHaveCount(0);
    await expect(page.getByTestId("plan-quit")).toHaveCount(0);
  });

  test("approves from an empty notes box, but types the letter once there is text", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    const requestId = await page.evaluate(() => window.__thanhMock!.plan());
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByTestId("plan-changes").click();
    const notes = page.getByTestId("plan-notes");
    await expect(notes).toBeVisible();

    // With text in the box `a` is a letter, not a verdict (`a_with_nonempty_freeform_types_letter`).
    await notes.fill("keep");
    await notes.press("a");
    await expect(notes).toHaveValue("keepa");
    expect((await mock.responses()).find((entry) => entry.id === requestId)).toBeUndefined();

    // Empty, it approves (`a_on_empty_revise_prompt_approves`).
    await notes.fill("");
    await notes.press("a");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await mock.responses()).find((entry) => entry.id === requestId)?.result).toEqual({ outcome: "approved" });
  });

  test("shows the empty-plan placeholder and quits from it", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    const requestId = await page.evaluate(() => window.__thanhMock!.plan({ planContent: null }));
    await expect(page.getByTestId("inline-interaction")).toHaveCount(0);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("plan.md (empty)");
    await expect(dialog).toContainText("No plan written yet");

    await page.getByTestId("plan-quit").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await mock.responses()).find((entry) => entry.id === requestId)?.result).toEqual({ outcome: "abandoned" });
  });

  test("shows the goal chip, its detail surface and the end-to-end row", async ({ page }) => {
    await openWorkspace(page, CONNECTED_SEED);
    await composer(page).fill("start the goal");
    await composer(page).press("Enter");
    // A goal belongs to a session, so wait for the prompt to create one before the shell reports.
    await expect(page.locator(".session-event")).toBeVisible();

    await page.evaluate(() => window.__thanhMock!.sessionNotification(window.__thanhMock!.goalUpdate({
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

    await page.evaluate(() => window.__thanhMock!.sessionNotification({
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

    await page.evaluate(() => window.__thanhMock!.sessionNotification(window.__thanhMock!.goalUpdate({ status: "complete", elapsed_ms: 619_000 })));
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

    await page.evaluate(() => window.__thanhMock!.sessionNotification(window.__thanhMock!.goalUpdate({
      verifying_completion: true,
      classifier_runs_attempted: 1,
      classifier_max_runs: 3,
    })));
    await expect(page.getByTestId("turn-status")).toContainText("Verifying…");
    await expect(page.getByTestId("goal-chip")).toContainText("Goal: Verifying (1/3)");
  });

  test("shows a paused goal's resume hint and drops it once cleared", async ({ page }) => {
    await openWorkspace(page, CONNECTED_SEED);
    await page.evaluate(() => window.__thanhMock!.sessionNotification(window.__thanhMock!.goalUpdate({
      status: "user_paused",
      pause_message: "user",
      elapsed_ms: 30_000,
    })));
    const chip = page.getByTestId("goal-chip");
    await expect(chip).toContainText("Goal: Paused");
    await chip.click();
    await expect(page.getByTestId("goal-detail")).toContainText("Status: Paused. Type /goal resume to continue");
    await page.keyboard.press("Escape");

    await page.evaluate(() => window.__thanhMock!.sessionNotification(window.__thanhMock!.goalUpdate({ status: "cleared", goal_id: "" })));
    await expect(chip).toHaveCount(0);
  });
});

test.describe("minimum window", () => {
  // `src-tauri/tauri.conf.json` pins the window to minWidth 840 / minHeight 600.
  test.use({ viewport: { width: 840, height: 600 } });

  test("keeps the composer, palette and providers usable", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openWorkspace(page, CONNECTED_SEED);

    await expect(page.getByPlaceholder("Ask Thanh anything…")).toBeVisible();
    await expect(page.getByTestId("send-button")).toBeVisible();

    // The slash menu opens upward from the composer, so the pinned minimum height must hold it.
    await page.getByPlaceholder("Ask Thanh anything…").fill("/");
    await expect(page.getByTestId("slash-item-plan")).toBeVisible();
    const menu = await page.getByTestId("slash-menu").boundingBox();
    expect(menu!.y).toBeGreaterThanOrEqual(0);
    expect(menu!.y + menu!.height).toBeLessThanOrEqual(600);
    // The info line ends before the send button rather than running under it.
    const info = await page.getByTestId("composer-info").boundingBox();
    const send = await page.getByTestId("send-button").boundingBox();
    expect(info!.x + info!.width).toBeLessThanOrEqual(send!.x);
    await page.getByPlaceholder("Ask Thanh anything…").fill("");

    await page.getByPlaceholder("Ask Thanh anything…").fill("minimum window turn");
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
});
