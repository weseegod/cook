import { expect, test, type Page } from "@playwright/test";
import { CONNECTED_SEED } from "./seed";
import {
  PNG_BASE64,
  api,
  callsTo,
  dropFile,
  imagePart,
  openWorkspace,
  pasteFile,
  waitForCalls,
} from "./support/harness";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

/**
 * End-to-end shell, chat and command flows through the shipped renderer over the recording mock
 * ACP transport.
 *
 * `VITE_MOCK_ACP=1` makes `src/acp/host.ts` swap the Tauri IPC bridge for
 * `src/acp/mock-transport.ts`; every mutation the UI performs is therefore an ACP request we can
 * read back, and the agent's own state is asserted after the fact.
 */

test.describe("first run", () => {
  test("connects a provider end to end without touching TOML", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const mock = api(page);
    await openWorkspace(page);

    // No provider and no agent credential: the connect flow replaces the chat.
    await expect(page.getByTestId("connect-provider")).toBeVisible();
    await expect(page.getByTestId("preset-openai").locator(".provider-logo-openai")).toBeVisible();
    await expect(page.getByTestId("preset-anthropic").locator(".provider-logo-claude")).toBeVisible();
    await expect(page.getByTestId("preset-xai").locator(".provider-logo-grok")).toBeVisible();
    await expect(page.getByTestId("preset-deepseek")).toBeVisible();
    await expect(page.getByTestId("preset-xiaomi")).toBeVisible();
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
    await page.getByTestId("oauth-use-api-key").click();
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
    await page.getByTestId("oauth-use-api-key").click();
    await page.getByLabel("API key").fill("sk-bad-key-0123456789");
    await page.getByTestId("provider-test").click();
    const result = page.getByTestId("provider-test-result");
    await expect(result).toContainText("Failed");
    await expect(result).toContainText("401");
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

    await page.getByRole("button", { name: "Model" }).click();
    await expect(page.getByRole("menu", { name: "Models" })).toBeVisible();
    await expect(page.locator(".composer-model-picker-group-label").first()).toHaveText("OpenAI");
    expect(errors).toEqual([]);
  });

  test("opens reasoning levels on hover and sends the selected level", async ({ page }) => {
    await openWorkspace(page, CONNECTED_SEED);

    await page.getByPlaceholder("Ask Cook anything…").fill("start a session");
    await page.getByTestId("send-button").click();
    await expect(page.getByText("Mock assistant reply.")).toBeVisible();

    await page.getByRole("button", { name: "Model" }).click();
    const modelRow = page.locator("[data-model-picker-item]").filter({ hasText: "GPT-5" }).first();
    await modelRow.hover();
    await expect(page.getByRole("menu", { name: "GPT-5 reasoning levels" })).toBeVisible();
    await page.getByRole("menuitemradio", { name: "Deep" }).click();

    const request = await waitForCalls(page, "session/set_model");
    expect(request.at(-1)?.params).toMatchObject({
      sessionId: "mock-session",
      modelId: "gpt-5",
      _meta: { reasoningEffort: "high" },
    });
    await expect(page.getByRole("button", { name: /Model/ })).toContainText("high");
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

  test("adds a model through the add-model popup", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Models" }).click();
    await page.getByTestId("provider-add-model-openai").click();
    await page.getByLabel("Model ID for openai").fill("gpt-custom");
    await page.getByLabel("Model display name").fill("GPT Custom");
    await expect(page.getByLabel("Reasoning")).toBeChecked();
    await page.getByTestId("model-save").click();
    const upserts = await waitForCalls(page, "x.ai/models/upsert");
    expect(upserts.at(-1)?.params).toMatchObject({ id: "gpt-custom", providerId: "openai", contextWindow: 300000, maxCompletionTokens: 64000, input: ["text"], supportsReasoningEffort: true });
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
    await expect(page.locator("[data-testid^='provider-row-']")).toHaveCount(9);
    await expect(page.getByTestId("provider-row-openai")).toContainText("Connected · API key");
    await expect(page.getByTestId("provider-row-openai").locator(".provider-logo-openai")).toBeVisible();
    await expect(page.getByTestId("provider-row-anthropic")).toContainText("Not connected");
    await expect(page.getByTestId("provider-row-xiaomi")).toContainText("Not connected");
    await expect(page.getByTestId("provider-row-xiaomi")).toContainText("Xiaomi MiMo");
    await expect(page.getByTestId("provider-row-anthropic").locator(".provider-logo-claude")).toBeVisible();
    await expect(page.getByTestId("provider-row-xai").locator(".provider-logo-grok")).toBeVisible();
    await expect(page.getByTestId("provider-row-deepseek").locator(".provider-logo-deepseek")).toBeVisible();
    await expect(page.getByTestId("provider-row-openrouter").locator(".provider-logo-openrouter")).toBeVisible();
    await expect(page.getByTestId("provider-row-xiaomi").locator(".provider-logo-xiaomi")).toBeVisible();
    await page.getByTestId("provider-add").click();
    const dialog = page.getByRole("dialog", { name: "Add provider" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("preset-openai").locator(".provider-logo-openai")).toBeVisible();
    await expect(dialog.getByTestId("preset-anthropic").locator(".provider-logo-claude")).toBeVisible();
    await expect(dialog.getByTestId("preset-xai").locator(".provider-logo-grok")).toBeVisible();
    await expect(dialog.getByTestId("preset-deepseek").locator(".provider-logo-deepseek")).toBeVisible();
    await expect(dialog.getByTestId("preset-openrouter").locator(".provider-logo-openrouter")).toBeVisible();
    await expect(dialog.getByTestId("preset-xiaomi").locator(".provider-logo-xiaomi")).toBeVisible();
    await expect(dialog.getByTestId("preset-xiaomi")).toBeVisible();
    await expect(dialog.getByTestId("preset-xiaomi")).toContainText("Xiaomi MiMo");
    await expect(dialog.getByText("Choose a provider")).toHaveCount(0);
    await dialog.getByLabel("Close dialog").click();
    await expect(dialog).toHaveCount(0);
  });

  test("Connect on Claude starts OAuth and records Connected · OAuth", async ({ page }) => {
    await openWorkspace(page, CONNECTED_SEED);
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Models" }).click();
    await page.getByTestId("provider-connect-anthropic").click();
    const dialog = page.getByTestId("oauth-dialog-anthropic");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".provider-logo-claude")).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Connect Claude" })).toBeVisible();
    await dialog.getByTestId("oauth-code").fill("claude-code#state");
    await page.getByTestId("oauth-submit").click();
    await expect(page.getByTestId("provider-row-anthropic")).toContainText("Connected · OAuth");
  });

  test("Connect on Grok starts device login and records Connected · OAuth", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Models" }).click();
    await page.getByTestId("provider-connect-xai").click();
    await expect(page.getByTestId("oauth-dialog-xai")).toBeVisible();
    await expect(page.getByTestId("oauth-user-code")).toHaveText("GROK-1234");
    const copyCode = page.getByTestId("oauth-copy-code");
    await expect(copyCode).toHaveText("Copy");
    await copyCode.click();
    await expect(copyCode).toHaveText("Copied");
    await mock.completeOAuth("xai");
    await expect(page.getByTestId("provider-row-xai")).toContainText("Connected · OAuth");
    await expect(page.getByTestId("provider-signout-xai")).toBeVisible();
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
    const replacement = page.getByRole("dialog", { name: "Choose a replacement model" });
    await expect(replacement).toBeVisible();
    await replacement.getByTestId("replacement-model").selectOption("deepseek-chat");
    await replacement.getByRole("button", { name: "Remove provider" }).click();

    await expect(page.getByTestId("model-row-gpt-5")).toHaveCount(0);
    await expect(page.getByTestId("provider-connect-openai")).toBeVisible();
    const removed = await mock.state();
    expect((removed.providers as Array<{ id: string }>).map((provider) => provider.id)).toEqual(["deepseek"]);
    expect(removed.defaultModel).toBe("deepseek-chat");
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
    const picker = page.getByRole("button", { name: "Model" });
    await expect(picker).toContainText("GPT-5");
    const listed = (await waitForCalls(page, "x.ai/models/list")).length;

    // The machine-wide form of `x.ai/models/update` has no payload: it says the catalog moved on
    // disk. Adopting it as a catalog would leave the picker empty and the selection dangling.
    await mock.modelsUpdate();
    await waitForCalls(page, "x.ai/models/list", listed + 1);
    await expect(picker).toContainText("GPT-5");
    await picker.click();
    await expect(page.locator("[data-model-picker-item]")).toHaveCount(2);
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

  test("runs /plan and turns plan mode on for the window", async ({ page }) => {
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
    await page.getByLabel("Model").click();
    await page.getByRole("menuitem", { name: "o4-mini" }).click();

    await composer(page).fill("What changed?");
    await page.getByTestId("send-button").click();
    await expect(page.getByText("Mock assistant reply.")).toBeVisible();

    const created = (await waitForCalls(page, "session/new"))[0];
    expect(created.params._meta).toMatchObject({ modelId: "o4-mini" });
    expect((await mock.state()).defaultModel).toBe("o4-mini");
    await expect(page.getByLabel("Model")).toContainText("o4-mini");
  });

  test("keeps a default the agent cannot write, and says where it applies", async ({ page }) => {
    const mock = api(page);
    // The shipped CLI predates `x.ai/models/set_default`; the window must not appear to ignore it.
    await openWorkspace(page, { ...CONNECTED_SEED, setDefaultUnsupported: true });

    // The default is chosen from the palette, which routes through `setDefaultModel`.
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("o4-mini");
    await page.getByTestId("palette-item-model-o4-mini").click();

    await expect(page.getByTestId("notice-banner")).toContainText("applies to this window only");
    await expect(page.getByLabel("Model")).toContainText("o4-mini");

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
    await expect(page.getByTestId("connector-linear")).toContainText("unavailable");
    await page.getByLabel("Toggle all filesystem").click();
    await expect(page.getByTestId("connector-filesystem")).toContainText("unavailable");

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

  test("opens a session so the tool list can be annotated when Settings is opened first", async ({ page }) => {
    await openWorkspace(page, CONNECTED_SEED);
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Connectors" }).click();

    // Tools hang off the session's MCP pool: without a session the agent has nothing to annotate.
    await waitForCalls(page, "session/new");
    await expect(page.getByTestId("connector-tool-filesystem-list_dir")).toBeVisible();
    await expect(page.getByTestId("connector-tool-filesystem-read_file")).toBeVisible();
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
});
