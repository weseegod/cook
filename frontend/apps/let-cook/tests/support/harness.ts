import { expect, test, type Page } from "@playwright/test";
import { CONNECTED_SEED, seedAgent } from "../seed";

/**
 * Scaffolding shared by the browser suites.
 *
 * Every suite drives the shipped renderer over the recording mock transport (`VITE_MOCK_ACP=1`
 * swaps the Tauri IPC bridge for `src/acp/mock-transport.ts`), so the helpers here all talk to
 * `window.__cookMock`: they seed the agent, load the app, and read back the RPC params the UI
 * sent.
 */

/** The plan file name the mock agent reports for the episode it reviews. */
export const MOCK_PLAN_FILE = "2026-09-19T14-30-22Z.md";

/** The review pane is titled from the plan's H1, so that is what it renders for this episode. */
export const MOCK_PLAN_TITLE = "Implementation plan";

/** One transparent pixel, used wherever a suite attaches or pastes an image. */
export const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A git workspace with one modified file; the header chip and diffstat suites read its review. */
export const WORKSPACE = {
  entries: {
    "": [
      { name: "src", path: "src", kind: "directory", size: null },
      { name: "README.md", path: "README.md", kind: "file", size: 420 },
    ],
    src: [{ name: "main.tsx", path: "src/main.tsx", kind: "file", size: 960 }],
  },
  files: {
    "README.md": { path: "README.md", content: "# Let Cook\n", size: 10, truncated: false, binary: false },
  },
  review: {
    base: "HEAD",
    isGitRepo: true,
    branch: "main",
    additions: 3,
    deletions: 1,
    files: [
      {
        path: "src/main.tsx",
        status: "modified",
        additions: 3,
        deletions: 1,
        diff: "diff --git a/src/main.tsx b/src/main.tsx\n@@ -1,2 +1,4 @@\n+export const ready = true;\n",
      },
    ],
  },
};

export type Recorded = { method: string; params: Record<string, unknown>; at: number };

/** The recording mock transport's test client. */
export function api(page: Page) {
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
    completeOAuth: (id: string) => page.evaluate((value) => window.__cookMock!.completeOAuth(value), id),
  };
}

/** A credentialed provider, so the first-run wizard stays out of the way, plus `overrides`. */
export const shellSeed = (overrides: Record<string, unknown> = {}) => ({ ...CONNECTED_SEED, ...overrides });

/** `shellSeed` with the git workspace fixture under it. */
export const gitSeed = (overrides: Record<string, unknown> = {}) => shellSeed({ workspace: WORKSPACE, ...overrides });

/** Load the app with a seeded agent state, then open the workspace. */
export async function openWorkspace(page: Page, seed: Record<string, unknown> = {}) {
  await seedAgent(page, seed);
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.waitForFunction(() => Boolean(window.__cookMock));
  await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
}

/** `refreshCommands` runs right after `session/new` is applied, so this counts applied sessions. */
function commandLists(page: Page): Promise<number> {
  return page.evaluate(() => window.__cookMock!.requests().filter((entry) => entry.method === "x.ai/commands/list").length);
}

/**
 * Open the workspace and start a conversation.
 *
 * A task or an activity row belongs to a conversation, so suites that push one wait until the
 * window holds a session id: a row sent before `session/new` lands belongs to no conversation yet.
 */
export async function openConversation(page: Page, seed: Record<string, unknown> = {}) {
  await openWorkspace(page, seed);
  const commandsBefore = await commandLists(page);
  await page.getByRole("button", { name: "New chat" }).click();
  await expect.poll(() => commandLists(page)).toBeGreaterThan(commandsBefore);
  await expect(page.getByTestId("composer-input")).toBeVisible();
}

export function callsTo(requests: Recorded[], method: string): Recorded[] {
  return requests.filter((entry) => entry.method === method);
}

/** Wait until the renderer has sent at least `count` calls of `method`, then return them. */
export async function waitForCalls(page: Page, method: string, count = 1): Promise<Recorded[]> {
  await expect
    .poll(async () => callsTo(await api(page).requests(), method).length, { timeout: 5000 })
    .toBeGreaterThanOrEqual(count);
  return callsTo(await api(page).requests(), method);
}

/** Dispatch a real HTML5 drop carrying one file, the way a browser (non-Tauri) load delivers it. */
export async function dropFile(page: Page, name: string, base64: string) {
  await page.getByTestId("composer-drop").evaluate((node, payload) => {
    const bytes = Uint8Array.from(atob(payload.base64), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], payload.name, { type: "image/png" }));
    node.dispatchEvent(new DragEvent("dragover", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    node.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, { name, base64 });
}

/** Dispatch a real paste event carrying one image file, as a screenshot clipboard would. */
export async function pasteFile(page: Page, name: string, base64: string) {
  await page.getByPlaceholder("Ask Cook anything…").evaluate((node, payload) => {
    const bytes = Uint8Array.from(atob(payload.base64), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], payload.name, { type: "image/png" }));
    node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, { name, base64 });
}

/** The image part the renderer put on the wire for the last prompt, if any. */
export async function imagePart(page: Page, mock: ReturnType<typeof api>) {
  const content = (await mock.requests()).filter((entry) => entry.method === "session/prompt");
  const parts = (content.at(-1)?.params.prompt ?? []) as Array<Record<string, unknown>>;
  return parts.find((part) => part.type === "image");
}

/** Keep a screenshot for every test when `PW_CAPTURE=1`. */
export const capture = async (page: Page, name: string) => {
  if (process.env.PW_CAPTURE === "1") {
    await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
  }
};

export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}
