import { expect, test, type Page } from "@playwright/test";
import { CONNECTED_SEED, seedAgent } from "./seed";

/**
 * Turn status metrics: after a finished mock turn the tokens/sec rail appears on the progress
 * status bar. Working-tree line changes moved to the header (see `header-diffstat.spec.ts`), so the
 * row carries only the rate.
 */

const WORKSPACE = {
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

async function openWorkspace(page: Page, overrides: Record<string, unknown> = {}) {
  await seedAgent(page, {
    ...CONNECTED_SEED,
    workspace: WORKSPACE,
    promptDelayMs: 500,
    reply: "A".repeat(200),
    ...overrides,
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.waitForFunction(() => Boolean(window.__cookMock));
  await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
}

test.describe("turn status metrics", () => {
  test("shows t/s on the status bar after a completed reply", async ({ page }) => {
    await openWorkspace(page);
    await expect(page.getByTestId("turn-status-tps")).toHaveCount(0);

    await page.getByTestId("composer-input").fill("Say hello in a long enough reply for TPS.");
    await page.getByTestId("send-button").click();

    await expect(page.getByTestId("turn-status-tps")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("turn-status-tps")).toContainText("t/s");
    await expect(page.getByTestId("turn-status")).toBeVisible();
    // The row no longer carries line changes: the header owns them.
    await expect(page.getByTestId("turn-status").locator(".header-diffstat")).toHaveCount(0);
  });

  test("measures a live t/s while the turn is still running", async ({ page }) => {
    await openWorkspace(page, { promptDelayMs: 12_000 });
    await page.getByTestId("composer-input").fill("Keep streaming for the t/s rail.");
    await page.getByTestId("send-button").click();
    await expect(page.getByRole("button", { name: "[stop]" })).toBeVisible();

    // Tokens arriving after the turn opened are what the sample interval reads.
    await page.waitForTimeout(600);
    await page.evaluate(() =>
      window.__cookMock!.sessionNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "A".repeat(2_000) },
      })
    );

    const tps = page.getByTestId("turn-status-tps");
    await expect(tps).toBeVisible({ timeout: 6_000 });
    await expect(tps).toContainText("t/s");
    // The turn is still open: the reading came from a sample, not from the turn ending.
    await expect(page.getByRole("button", { name: "[stop]" })).toBeVisible();
  });

  test("keeps one time on the row and places context usage in the composer", async ({ page }) => {
    await openWorkspace(page, { promptDelayMs: 12_000 });
    await page.getByTestId("composer-input").fill("Hold the turn open.");
    await page.getByTestId("send-button").click();
    await page.waitForTimeout(600);
    await page.evaluate(() =>
      window.__cookMock!.sessionNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "B".repeat(2_000) },
      })
    );

    const row = page.getByTestId("turn-status");
    await expect(row.locator(".turn-status-phase")).toHaveText(/\d/);
    // The whole-turn clock lives on the conversation row in the sidebar, and context usage lives
    // in the composer footer — the row carries neither.
    await expect(row.locator(".turn-status-timer")).toHaveCount(0);
    await expect(row.locator(".turn-status-tokens")).toHaveCount(0);
    await expect(page.getByTestId("composer-info").getByLabel("Context status")).toBeVisible();

    const [phaseBox, tpsBox] = await Promise.all([
      row.locator(".turn-status-phase").boundingBox(),
      row.locator(".turn-status-tps").boundingBox(),
    ]);
    const rowBox = (await row.boundingBox())!;
    // Left to right: the activity and its phase timer, then the rate at the right end.
    expect(phaseBox!.x).toBeLessThan(rowBox.x + rowBox.width / 2);
    expect(tpsBox!.x).toBeGreaterThan(rowBox.x + rowBox.width / 2);
  });
});
