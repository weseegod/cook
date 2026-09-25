import { expect, test, type Page } from "@playwright/test";
import { gitSeed, openWorkspace } from "./support/harness";

/**
 * The header's Git chip shows the branch and `+N −M` line changes together. Its Preview menu item
 * shows the changed-file count and opens the Tools panel's changed-file and patch view.
 */

/** The git workspace under a turn that streams long enough to outlive the probe interval. */
const launch = (page: Page, overrides: Record<string, unknown> = {}) =>
  openWorkspace(page, gitSeed({ promptDelayMs: 500, reply: "A".repeat(200), ...overrides }));

test.describe("header line changes", () => {
  test("shows line changes after the branch inside the Git chip", async ({ page }) => {
    await launch(page);

    const chip = page.getByTestId("git-chip");
    const diffstat = page.getByTestId("header-diffstat");
    await expect(diffstat).toBeVisible();
    await expect(diffstat).toContainText("3");
    await expect(diffstat).toContainText("1");
    await expect(chip).toHaveAttribute("title", /\+3 −1/);
    await expect(chip.locator(".git-chip-branch")).toHaveText("main");
    await expect(chip.locator(".git-chip-count")).toHaveCount(0);

    const [plan, chipBox, branch, stats] = await Promise.all([
      page.getByTestId("plan-chip").boundingBox(),
      chip.boundingBox(),
      chip.locator(".git-chip-branch").boundingBox(),
      diffstat.boundingBox(),
    ]);
    expect(plan!.x + plan!.width).toBeLessThan(chipBox!.x);
    expect(branch!.x + branch!.width).toBeLessThanOrEqual(stats!.x + 1);
  });

  test("follows the working tree while the turn is still running", async ({ page }) => {
    // A tool call in the turn is what tells the probe the tree may have changed.
    await launch(page, {
      promptDelayMs: 12_000,
      promptUpdates: [
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Editing now." } },
        { sessionUpdate: "tool_call", toolCallId: "edit-1", kind: "edit", title: "Edit src/main.tsx", status: "pending" },
        { sessionUpdate: "tool_call_update", toolCallId: "edit-1", status: "completed" },
      ],
    });
    await expect(page.getByTestId("header-diffstat")).toContainText("3");

    await page.getByTestId("composer-input").fill("Edit the workspace for a live diffstat.");
    await page.getByTestId("send-button").click();
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

    const diffstat = page.getByTestId("header-diffstat");
    // The tree grows underneath the running turn; the 1.5s probe picks it up without a turn boundary.
    await page.evaluate(() => window.__cookMock!.workspaceReview({ additions: 128, deletions: 64 }));
    await expect(diffstat).toContainText("128", { timeout: 10_000 });
    await expect(diffstat).toContainText("64");
    await expect(page.getByTestId("git-chip")).toHaveAttribute("title", /\+128 −64/);
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  });

  test("opens the changed-file preview from the Git chip menu", async ({ page }) => {
    await launch(page);

    await expect(page.getByTestId("utility-panel")).toHaveCount(0);
    await page.getByTestId("git-chip").click();
    await page.getByTestId("git-preview").click();

    const panel = page.getByTestId("utility-panel");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("review-view")).toBeVisible();
    await expect(page.getByTestId("review-view")).toContainText("src/main.tsx");

    // Preview returns to the changed-file view after a manual switch to Files.
    await panel.locator(".utility-back").click();
    await panel.getByRole("button", { name: "Files" }).click();
    await expect(page.getByTestId("files-view")).toBeVisible();
    await page.getByTestId("git-chip").click();
    await page.getByTestId("git-preview").click();
    await expect(page.getByTestId("review-view")).toBeVisible();
  });

  test("stays off the row at the minimum window size", async ({ page }) => {
    await page.setViewportSize({ width: 840, height: 600 });
    await launch(page);

    await expect(page.getByTestId("git-chip")).toBeVisible();
    await expect(page.getByTestId("git-chip").getByTestId("header-diffstat")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
