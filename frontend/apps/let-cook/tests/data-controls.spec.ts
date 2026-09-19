import { expect, test, type Page } from "@playwright/test";
import { CONNECTED_SEED, seedAgent } from "./seed";

/**
 * Settings → Data Controls: "Delete all conversations", behind a confirmation, erasing every
 * conversation and the plan files they produced.
 *
 * The wipe runs in the agent (`x.ai/sessions/delete_all`); this suite drives the shipped renderer
 * over the recording mock transport and reads back both the request and the agent-side state, so a
 * screen that merely looks erased cannot pass.
 */

const PLAN_DIR = "/tmp/cook-demo/.cook/sessions/%2Ftmp%2Fcook-demo/mock-session/plans";
const NEWEST = "2026-09-19T14-30-22Z.md";

const DATA_SEED = {
  ...CONNECTED_SEED,
  sessions: [
    { id: "session-login", title: "Fix login bug", cwd: "/tmp/cook-demo", updatedAt: "2026-09-17T10:00:00Z" },
    { id: "session-providers", title: "Provider settings", cwd: "/tmp/cook-demo", updatedAt: "2026-09-15T10:00:00Z" },
    { id: "session-plans", title: "Plan the plan list", cwd: "/tmp/cook-demo", updatedAt: "2026-09-14T10:00:00Z" },
  ],
  planFiles: [
    { name: NEWEST, path: `${PLAN_DIR}/${NEWEST}`, relativePath: `plans/${NEWEST}`, sizeBytes: 1368, modifiedMs: Date.parse("2026-09-19T14:30:22Z"), active: true, deletable: false, content: "# Current plan" },
    { name: "2026-09-18T09-15-00Z.md", path: `${PLAN_DIR}/2026-09-18T09-15-00Z.md`, relativePath: "plans/2026-09-18T09-15-00Z.md", sizeBytes: 804, modifiedMs: Date.parse("2026-09-18T09:15:00Z"), active: false, deletable: true, content: "# First plan" },
  ],
};

type Recorded = { method: string; params: Record<string, unknown>; at: number };

function api(page: Page) {
  return {
    requests: (): Promise<Recorded[]> => page.evaluate(() => window.__cookMock!.requests()),
    state: (): Promise<Record<string, unknown>> =>
      page.evaluate(() => window.__cookMock!.state() as unknown as Record<string, unknown>),
  };
}

const capture = async (page: Page, name: string) => {
  if (process.env.PW_CAPTURE === "1") {
    await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
  }
};

async function openWorkspace(page: Page, seed: Record<string, unknown> = DATA_SEED) {
  await seedAgent(page, seed);
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.waitForFunction(() => Boolean(window.__cookMock));
  await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
}

/** Settings → Data Controls. */
async function openDataControls(page: Page) {
  await page.getByLabel("Settings").click();
  await page.getByRole("tab", { name: "Data Controls" }).click();
  await expect(page.getByTestId("delete-all-conversations")).toBeVisible();
}

/** The wipe's confirmation, which sits above the Settings panel that is also a dialog. */
const confirmDialog = (page: Page) => page.locator(".dialog");

test.describe("data controls", () => {
  test("cancels out of the wipe without deleting anything", async ({ page }) => {
    await openWorkspace(page);
    await openDataControls(page);
    await capture(page, "data-controls");

    await page.getByTestId("delete-all-conversations").click();
    const dialog = confirmDialog(page);
    await expect(dialog).toContainText("Delete all conversations?");
    // The confirmation has to name the blast radius, plans included, before anything runs.
    await expect(dialog).toContainText("plan files");
    await expect(dialog).toContainText("cannot be undone");

    await dialog.getByRole("button", { name: "Cancel" }).click();

    await expect(page.getByTestId("delete-all-confirm")).toHaveCount(0);
    const requests = (await api(page).requests()).filter((entry) => entry.method === "x.ai/sessions/delete_all");
    expect(requests).toHaveLength(0);
  });

  test("deletes every conversation and plan file once confirmed", async ({ page }) => {
    await openWorkspace(page);
    await expect(page.getByTestId("session-row-session-plans")).toBeVisible();
    // A conversation with plans behind it: the header chip lists them before the wipe.
    await page.getByTestId("composer-input").fill("show me the plans");
    await page.getByTestId("composer-input").press("Enter");
    await expect(page.getByText("Mock assistant reply.")).toBeVisible();

    await openDataControls(page);
    await page.getByTestId("delete-all-conversations").click();
    await capture(page, "data-controls-confirm");
    await page.getByTestId("delete-all-confirm").click();

    await expect(page.getByTestId("notice-banner")).toContainText("Deleted 3 conversations and 2 plan files");
    const stored = (await api(page).state()) as {
      sessions: Array<{ id: string }>;
      planFiles: Array<{ name: string }>;
    };
    // The agent's own state is what proves the erase: no conversations, no plan files.
    expect(stored.sessions).toEqual([]);
    expect(stored.planFiles).toEqual([]);
    const request = (await api(page).requests())
      .filter((entry) => entry.method === "x.ai/sessions/delete_all")
      .at(-1);
    expect(request?.params).toEqual({});

    // Nothing survives on screen either: no rows, no plans, and the open conversation is gone.
    await page.keyboard.press("Escape");
    for (const id of ["session-login", "session-providers", "session-plans"]) {
      await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(0);
    }
    await expect(page.getByTestId("composer-input")).toBeVisible();
    await page.getByTestId("plan-chip").click();
    await expect(page.getByTestId("plan-menu-empty")).toContainText("No plans in this conversation yet");
  });

  test("reports an agent that cannot run the wipe", async ({ page }) => {
    await openWorkspace(page, { ...DATA_SEED, deleteAllUnsupported: true });
    await openDataControls(page);

    await page.getByTestId("delete-all-conversations").click();
    await page.getByTestId("delete-all-confirm").click();

    // The dialog stays up with the reason, and nothing was erased.
    await expect(confirmDialog(page).getByRole("alert")).toContainText("delete");
    const stored = (await api(page).state()) as { sessions: Array<{ id: string }> };
    expect(stored.sessions).toHaveLength(3);
  });

  test("keeps the panel inside a narrow window", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openWorkspace(page);
    await openDataControls(page);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("delete-all-conversations")).toBeVisible();
    await capture(page, "data-controls-narrow");
  });

  test("keeps both themes legible", async ({ page }) => {
    await openWorkspace(page);
    await openDataControls(page);

    const readable = async () => {
      const style = await page.getByTestId("delete-all-conversations").evaluate((node) => {
        const computed = getComputedStyle(node);
        return { color: computed.color, background: computed.backgroundColor };
      });
      expect(style.color).not.toBe(style.background);
      // The destructive action has to read as destructive, not as another ghost button.
      return style.color;
    };
    const dark = await readable();

    // Settings stays open; the theme lives on its General tab.
    await page.getByRole("tab", { name: "General" }).click();
    await page.getByTestId("theme-option-light").click();
    await page.getByRole("tab", { name: "Data Controls" }).click();
    const light = await readable();
    expect(light).not.toBe(dark);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await capture(page, "data-controls-light");
  });
});
