import { expect, test, type Page } from "@playwright/test";
import { CONNECTED_SEED, seedAgent } from "./seed";

/**
 * The header's plan list: one row per plan file in the session, the current episode marked, with a
 * hover three-dot menu offering Copy, Copy file path and Delete.
 *
 * Runs the shipped renderer over the recording mock transport, so every action the UI takes is an
 * ACP request we can read back (`x.ai/session/plans`, `x.ai/session/plans/delete`).
 */

/** The plan files the agent reports for this session, newest first. */
const NEWEST = "2026-09-19T14-30-22Z.md";
const MIDDLE = "2026-09-19T11-02-05Z.md";
const OLDEST = "2026-09-18T09-15-00Z.md";
const PLAN_DIR = "/tmp/cook-demo/.cook/sessions/%2Ftmp%2Fcook-demo/mock-session/plans";

type Recorded = { method: string; params: Record<string, unknown>; at: number };

function api(page: Page) {
  return {
    requests: (): Promise<Recorded[]> => page.evaluate(() => window.__cookMock!.requests()),
    state: (): Promise<Record<string, unknown>> =>
      page.evaluate(() => window.__cookMock!.state() as unknown as Record<string, unknown>),
  };
}

/** Three episodes: the newest is what the session is planning in now. */
const PLAN_SEED = {
  ...CONNECTED_SEED,
  planFiles: [
    { name: NEWEST, path: `${PLAN_DIR}/${NEWEST}`, relativePath: `plans/${NEWEST}`, sizeBytes: 1368, modifiedMs: Date.parse("2026-09-19T14:30:22Z"), active: true, deletable: false, content: "# Current plan\n\n1. Add the plan list" },
    { name: MIDDLE, path: `${PLAN_DIR}/${MIDDLE}`, relativePath: `plans/${MIDDLE}`, sizeBytes: 828, modifiedMs: Date.parse("2026-09-19T11:02:05Z"), active: false, deletable: true, content: "# Middle plan\n\n1. Ship the chip" },
    { name: OLDEST, path: `${PLAN_DIR}/${OLDEST}`, relativePath: `plans/${OLDEST}`, sizeBytes: 804, modifiedMs: Date.parse("2026-09-18T09:15:00Z"), active: false, deletable: true, content: "# First plan\n\n1. Allocate one file per episode" },
  ],
};

async function openWorkspace(page: Page, seed: Record<string, unknown> = PLAN_SEED) {
  await seedAgent(page, seed);
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.waitForFunction(() => Boolean(window.__cookMock));
  await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
}

/**
 * A plan page belongs to a session, and the shell creates the session on the first prompt
 * (`ensureSession`), so every test that expects the chip has to send one.
 */
async function startSession(page: Page) {
  const composer = page.getByTestId("composer-input");
  await composer.fill("show me the plans");
  await composer.press("Enter");
  await expect(page.getByText("Mock assistant reply.")).toBeVisible();
}

/** The context permission Chromium needs before `navigator.clipboard.readText` resolves. */
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const capture = async (page: Page, name: string) => {
  if (process.env.PW_CAPTURE === "1") {
    await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
  }
};

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe("plan list", () => {
  test("keeps the conversation's plans on the header before any episode is written", async ({ page }) => {
    await openWorkspace(page, { ...CONNECTED_SEED, planFiles: [] });
    await startSession(page);

    // The chip belongs to the conversation, not to the moment the first plan file lands.
    await expect(page.getByTestId("plan-chip")).toBeVisible();
    await expect(page.getByTestId("plan-chip")).toContainText("plan");
    await page.getByTestId("plan-chip").click();
    await expect(page.getByTestId("plan-menu")).toBeVisible();
    await expect(page.getByTestId("plan-menu-empty")).toContainText("No plans in this conversation yet");
    await expect(page.locator(".plan-menu-row")).toHaveCount(0);
    await capture(page, "plan-list-empty");
  });

  test("lists the session's plan files with the current episode marked", async ({ page }) => {
    await openWorkspace(page);
    await startSession(page);
    await expect(page.getByTestId("plan-chip")).toBeVisible();

    // The chip names the episode the session is planning in, not the first or the last file seen.
    await expect(page.getByTestId("plan-chip")).toContainText(NEWEST);

    await page.getByTestId("plan-chip").click();

    const rows = page.locator(".plan-menu-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText(NEWEST);
    await expect(rows.nth(1)).toContainText(MIDDLE);
    await expect(rows.nth(2)).toContainText(OLDEST);
    // Newest first is the creation order the file names carry; exactly one row is current.
    await expect(page.getByTestId("plan-file-current")).toHaveCount(1);
    await expect(page.getByTestId(`plan-file-row-${NEWEST}`)).toHaveClass(/active/);
    await expect(page.getByTestId(`plan-file-row-${MIDDLE}`)).not.toHaveClass(/active/);
    // The row's second line reports the size and last write.
    await expect(page.getByTestId(`plan-file-row-${NEWEST}`)).toContainText("1 KB");

    const calls = (await api(page).requests()).filter((entry) => entry.method === "x.ai/session/plans");
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.at(-1)?.params).toMatchObject({ sessionId: "mock-session", cwd: "/tmp/cook-demo" });
  });

  test("hides the row actions until the row is hovered, then offers Copy, Copy file path and Delete", async ({ page }) => {
    await openWorkspace(page);
    await startSession(page);
    await page.getByTestId("plan-chip").click();

    const dots = page.getByTestId(`plan-file-actions-${MIDDLE}`);
    // Present but invisible: the menu belongs to the row, and hover reveals it.
    await expect(dots).toBeHidden();
    await page.getByTestId(`plan-file-row-${MIDDLE}`).hover();
    await expect(dots).toBeVisible();

    await dots.click();
    const menu = page.getByTestId(`plan-file-menu-${MIDDLE}`);
    await expect(menu).toBeVisible();
    await capture(page, "plan-row-menu");
    await expect(menu.getByRole("menuitem")).toHaveCount(3);
    await expect(page.getByTestId("plan-file-copy")).toContainText("Copy");
    await expect(page.getByTestId("plan-file-copy-path")).toContainText("Copy file path");
    await expect(page.getByTestId("plan-file-delete")).toContainText("Delete");
    // Delete is the danger action, and it stays enabled for an earlier episode.
    await expect(page.getByTestId("plan-file-delete")).toHaveClass(/plan-row-menu-danger/);
    await expect(page.getByTestId("plan-file-delete")).toBeEnabled();
  });

  test("copies the plan body and the absolute path", async ({ page }) => {
    await openWorkspace(page);
    await startSession(page);
    await page.getByTestId("plan-chip").click();

    await page.getByTestId(`plan-file-row-${MIDDLE}`).hover();
    await page.getByTestId(`plan-file-actions-${MIDDLE}`).click();
    await page.getByTestId("plan-file-copy").click();
    await expect(page.getByTestId("notice-banner")).toContainText(`Copied ${MIDDLE}`);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("# Middle plan\n\n1. Ship the chip");

    await page.getByTestId(`plan-file-row-${OLDEST}`).hover();
    await page.getByTestId(`plan-file-actions-${OLDEST}`).click();
    await page.getByTestId("plan-file-copy-path").click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${PLAN_DIR}/${OLDEST}`);
    await expect(page.getByTestId("notice-banner")).toContainText(`${PLAN_DIR}/${OLDEST}`);
  });

  test("opens an earlier plan read-only and the current one in the review pane", async ({ page }) => {
    await openWorkspace(page);
    await startSession(page);

    // The current episode has a parked review behind it, so its row reopens the review pane.
    const requestId = await page.evaluate(() => window.__cookMock!.plan());
    await expect(page.getByTestId("plan-pane")).toBeVisible();
    await page.getByTestId("dialog-hide").click();
    await expect(page.getByTestId("plan-pane")).toHaveCount(0);
    await page.getByTestId("plan-chip").click();
    await page.getByTestId(`plan-file-open-${NEWEST}`).click();
    await expect(page.getByTestId("plan-pane")).toBeVisible();

    // An earlier plan has no decision attached: it opens as a read-only document.
    await page.getByTestId("plan-chip").click();
    await page.getByTestId(`plan-file-open-${OLDEST}`).click();
    const viewer = page.getByRole("dialog");
    await expect(viewer).toContainText(OLDEST);
    await expect(viewer).toContainText("Allocate one file per episode");
    expect((await api(page).requests()).some((entry) => entry.method === "x.ai/session/plans/delete")).toBe(false);

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("plan-file-body")).toHaveCount(0);
    // The parked review is untouched: nothing answered it.
    const responses = await page.evaluate(() => window.__cookMock!.responses());
    expect(responses.find((entry) => entry.id === requestId)).toBeUndefined();
  });

  test("refuses Delete on the current episode and deletes an earlier plan after confirming", async ({ page }) => {
    await openWorkspace(page);
    await startSession(page);
    await page.getByTestId("plan-chip").click();

    // The current plan is what the running episode holds, so the agent will not delete it.
    await page.getByTestId(`plan-file-row-${NEWEST}`).hover();
    await page.getByTestId(`plan-file-actions-${NEWEST}`).click();
    await expect(page.getByTestId("plan-file-delete")).toBeDisabled();
    await expect(page.getByTestId("plan-file-delete")).toHaveAttribute("title", /current plan cannot be deleted/);
    // Close the row menu before reaching for the row it covers.
    await page.getByTestId(`plan-file-actions-${NEWEST}`).click();
    await expect(page.getByTestId(`plan-file-menu-${NEWEST}`)).toHaveCount(0);

    await page.getByTestId(`plan-file-row-${MIDDLE}`).hover();
    await page.getByTestId(`plan-file-actions-${MIDDLE}`).click();
    await page.getByTestId("plan-file-delete").click();
    await expect(page.getByRole("dialog")).toContainText(`Delete ${MIDDLE}?`);
    await page.getByTestId("plan-delete-confirm").click();

    await expect(page.getByTestId("notice-banner")).toContainText(`Deleted ${MIDDLE}`);
    await expect(page.getByTestId(`plan-file-row-${MIDDLE}`)).toHaveCount(0);
    await expect(page.locator(".plan-menu-row")).toHaveCount(2);
    // The agent's own state lost the file, and the request carried the absolute path.
    const stored = (await api(page).state()) as { planFiles: Array<{ name: string }> };
    expect(stored.planFiles.map((file) => file.name)).toEqual([NEWEST, OLDEST]);
    const deletes = (await api(page).requests()).filter((entry) => entry.method === "x.ai/session/plans/delete");
    expect(deletes.at(-1)?.params).toMatchObject({ sessionId: "mock-session", path: `${PLAN_DIR}/${MIDDLE}` });
  });

  test("keeps the chip's earlier behavior when the agent serves no plan list", async ({ page }) => {
    await openWorkspace(page, { ...CONNECTED_SEED, planListUnsupported: true });
    await startSession(page);

    // The header still carries the conversation's plans; an agent that serves no list leaves it empty.
    await expect(page.getByTestId("plan-chip")).toBeVisible();
    await page.getByTestId("plan-chip").click();
    await expect(page.getByTestId("plan-menu-empty")).toContainText("No plans in this conversation yet");
    await expect(page.locator(".plan-menu-row")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("plan-menu")).toHaveCount(0);

    // A parked review still takes over the click and opens the review itself.
    await page.evaluate(() => window.__cookMock!.plan());
    await expect(page.getByTestId("plan-chip")).toBeVisible();
    await page.getByTestId("dialog-hide").click();
    await expect(page.getByTestId("plan-pane")).toHaveCount(0);
    await page.getByTestId("plan-chip").click();
    await expect(page.getByTestId("plan-menu")).toHaveCount(0);
    await expect(page.getByTestId("plan-pane")).toBeVisible();
  });

  test("keeps the list readable in both themes and paints Delete differently", async ({ page }) => {
    await openWorkspace(page);
    await startSession(page);
    await page.getByTestId("plan-chip").click();
    await expect(page.getByTestId("plan-menu")).toBeVisible();
    await capture(page, "plan-list-dark");

    await page.getByTestId(`plan-file-row-${MIDDLE}`).hover();
    await page.getByTestId(`plan-file-actions-${MIDDLE}`).click();
    await expect(page.getByTestId("plan-file-delete")).toBeVisible();
    // "Delete (color different)": the destructive row is not painted like the two copy rows.
    const [danger, copy] = await Promise.all([
      page.getByTestId("plan-file-delete").evaluate((node) => getComputedStyle(node).color),
      page.getByTestId("plan-file-copy").evaluate((node) => getComputedStyle(node).color),
    ]);
    expect(danger).not.toBe(copy);

    await page.keyboard.press("Escape");
    await page.getByLabel("Settings").click();
    await page.getByTestId("theme-option-light").click();
    await page.keyboard.press("Escape");
    await page.getByTestId("plan-chip").click();
    await expect(page.getByTestId("plan-menu")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await capture(page, "plan-list-light");
  });

  test("keeps the list inside a narrow window", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openWorkspace(page);
    await startSession(page);
    // The shell itself overflows this viewport; only overflow the list adds is a regression here.
    const baseline = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await page.getByTestId("plan-chip").click();
    await expect(page.getByTestId("plan-menu")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(baseline + 1);

    const box = (await page.getByTestId("plan-menu").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    // The row menu stays reachable under the pointer at this width too.
    await page.getByTestId(`plan-file-row-${OLDEST}`).hover();
    await page.getByTestId(`plan-file-actions-${OLDEST}`).click();
    await expect(page.getByTestId(`plan-file-menu-${OLDEST}`)).toBeVisible();
  });
});
