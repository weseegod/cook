import { expect, test, type Page } from "@playwright/test";
import { gitSeed, openWorkspace } from "./support/harness";

/**
 * Turn status metrics: after a finished mock turn the tokens/sec rail appears on the progress
 * status bar. Working-tree line changes moved to the header (see `header-diffstat.spec.ts`), so the
 * row carries only the rate.
 */

/** The git workspace under a reply long enough for the sampler to measure a rate. */
const launch = (page: Page, overrides: Record<string, unknown> = {}) =>
  openWorkspace(page, gitSeed({ promptDelayMs: 500, reply: "A".repeat(200), ...overrides }));

test.describe("turn status metrics", () => {
  test("shows t/s on the status bar after a completed reply", async ({ page }) => {
    await launch(page);
    await expect(page.getByTestId("turn-status-tps")).toHaveCount(0);

    await page.getByTestId("composer-input").fill("Say hello in a long enough reply for TPS.");
    await page.getByTestId("send-button").click();

    await expect(page.getByTestId("turn-status-tps")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("turn-status-tps")).toContainText("t/s");
    await expect(page.getByTestId("turn-status")).toBeVisible();
    // The row no longer carries line changes: the header owns them.
    await expect(page.getByTestId("turn-status").locator(".header-diffstat")).toHaveCount(0);
  });

  test("keeps one time on the row and places context usage in the composer", async ({ page }) => {
    await launch(page, { promptDelayMs: 12_000 });
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
