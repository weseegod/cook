import { expect, test, type Page } from "@playwright/test";
import { gitSeed, openWorkspace } from "./support/harness";

/**
 * The header's line changes: `+N −M` for the working tree, parked immediately left of the git chip,
 * refreshed behind a running turn, and the way into the Tools panel's Review view.
 */

/** The git workspace under a turn that streams long enough to outlive the probe interval. */
const launch = (page: Page, overrides: Record<string, unknown> = {}) =>
  openWorkspace(page, gitSeed({ promptDelayMs: 500, reply: "A".repeat(200), ...overrides }));

test.describe("header line changes", () => {
  test("sit between the plan chip and the git chip without a turn running", async ({ page }) => {
    await launch(page);

    const diffstat = page.getByTestId("header-diffstat");
    await expect(diffstat).toBeVisible();
    await expect(diffstat).toContainText("3");
    await expect(diffstat).toContainText("1");
    await expect(diffstat).toHaveAttribute("title", /\+3 −1 in the working tree/);

    const [plan, rail, chip] = await Promise.all([
      page.getByTestId("plan-chip").boundingBox(),
      diffstat.boundingBox(),
      page.getByTestId("git-chip").boundingBox(),
    ]);
    // The plan chip moved out to the left cluster; the rail reads immediately left of the chip.
    expect(plan!.x + plan!.width).toBeLessThan(rail!.x);
    expect(rail!.x + rail!.width).toBeLessThanOrEqual(chip!.x + 1);
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
    await expect(page.getByRole("button", { name: "[stop]" })).toBeVisible();

    const diffstat = page.getByTestId("header-diffstat");
    // The tree grows underneath the running turn; the 1.5s probe picks it up without a turn boundary.
    await page.evaluate(() => window.__cookMock!.workspaceReview({ additions: 128, deletions: 64 }));
    await expect(diffstat).toContainText("128", { timeout: 10_000 });
    await expect(diffstat).toContainText("64");
    await expect(diffstat).toHaveAttribute("title", /\+128 −64 in the working tree/);
    await expect(page.getByRole("button", { name: "[stop]" })).toBeVisible();
  });

  test("opens the Tools panel on Review when clicked", async ({ page }) => {
    await launch(page);

    await expect(page.getByTestId("utility-panel")).toHaveCount(0);
    await page.getByTestId("header-diffstat").click();

    const panel = page.getByTestId("utility-panel");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("review-view")).toBeVisible();
    await expect(page.getByTestId("review-view")).toContainText("src/main.tsx");

    // A second click returns to Review after the panel was switched elsewhere.
    await panel.locator(".utility-back").click();
    await panel.getByRole("button", { name: "Files" }).click();
    await expect(page.getByTestId("files-view")).toBeVisible();
    await page.getByTestId("header-diffstat").click();
    await expect(page.getByTestId("review-view")).toBeVisible();
  });

  test("stays off the row at the minimum window size", async ({ page }) => {
    await page.setViewportSize({ width: 840, height: 600 });
    await launch(page);

    await expect(page.getByTestId("header-diffstat")).toBeVisible();
    await expect(page.getByTestId("git-chip")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
