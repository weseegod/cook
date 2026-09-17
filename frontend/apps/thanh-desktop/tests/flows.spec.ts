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
  await expect(page.getByRole("button", { name: "New conversation" })).toBeVisible();
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
    await expect(page.getByTestId("preset-ollama")).toBeVisible();
    await expect(page.getByTestId("preset-custom")).toBeVisible();

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
    await page.getByRole("tab", { name: "Providers" }).click();
    await expect(page.getByTestId("provider-row-deepseek")).toContainText("sk…abcd");
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
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    await openWorkspace(page);
    await expect(page.getByTestId("connect-provider")).toHaveCount(0);
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Providers" }).click();
    await expect(page.getByTestId("provider-row-deepseek")).toContainText("API key saved");
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
    await page.getByRole("tab", { name: "Providers" }).click();
    await expect(page.getByTestId("provider-row-openai")).toContainText("API key saved");
    await expect(page.getByTestId("provider-row-openai")).toContainText("sk…cdef");
    await expect(page.locator(".settings-panel")).not.toContainText("sk-mock-0123456789abcdef");
  });

  test("skips the wizard for a CLI user whose config already works", async ({ page }) => {
    await openWorkspace(page, { authMethodId: "xai-session", defaultModel: "grok-4.5" });
    await expect(page.getByTestId("connect-provider")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
  });

  test("stays dismissed once the user skips it", async ({ page }) => {
    await openWorkspace(page);
    await expect(page.getByTestId("connect-provider")).toBeVisible();
    await page.getByTestId("connect-skip").click();
    await expect(page.getByTestId("connect-provider")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "New conversation" })).toBeVisible();
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
    await expect(page.locator(".composer-hint")).toHaveAttribute("title", "Images are unavailable for this text-only model");
    await page.getByTestId("attach-input").setInputFiles({
      name: "shot.png",
      mimeType: "image/png",
      buffer: Buffer.from(PNG_BASE64, "base64"),
    });
    await expect(page.getByTestId("attachment-row")).toHaveCount(0);
    await expect(page.locator(".error-banner")).toContainText("cannot read images");
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

  test("runs /plan, then leaves plan mode from the status bar", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);

    await composer(page).fill("/plan");
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("notice-banner")).toContainText("Plan mode is on");
    await expect(page.locator(".plan-banner")).toBeVisible();
    const modes = await waitForCalls(page, "session/set_mode");
    expect(modes[0].params).toMatchObject({ sessionId: "mock-session", modeId: "plan" });
    expect((await mock.state()).sessionMode).toBe("plan");

    await page.getByTestId("plan-toggle").click();
    await expect.poll(async () => (await mock.state()).sessionMode).toBe("default");
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

    // A turn is what makes the agent report context usage; the status bar shows it from then on,
    // out of `x.ai/session/info` — a real turn sends no `usage_update`.
    await composer(page).fill("hello");
    await page.getByTestId("send-button").click();
    await expect(page.getByText("Mock assistant reply.")).toBeVisible();
    await expect(page.locator(".statusbar")).toContainText("tokens");
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
    await page.getByRole("button", { name: "New conversation" }).click();
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

    await page.getByRole("tab", { name: "Memory & project" }).click();
    await page.getByTestId("memory-flush").click();
    await expect(page.getByTestId("memory-status")).toContainText("flush requested");
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
    // The footer hint ends before the send button rather than running under it.
    const hint = await page.locator(".composer-hint").boundingBox();
    const send = await page.getByTestId("send-button").boundingBox();
    expect(hint!.x + hint!.width).toBeLessThanOrEqual(send!.x);
    await page.getByPlaceholder("Ask Thanh anything…").fill("");

    await page.getByPlaceholder("Ask Thanh anything…").fill("minimum window turn");
    await page.getByTestId("send-button").click();
    await expect(page.getByText("Mock assistant reply.")).toBeVisible();
    await waitForCalls(page, "session/prompt");

    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Providers" }).click();
    await expect(page.getByTestId("provider-row-openai")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
    await page.getByLabel("Settings").click();
    await page.keyboard.press("Meta+w");
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New conversation" })).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });
});
