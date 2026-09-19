import { expect, test, type Page } from "@playwright/test";
import { CONNECTED_SEED, seedAgent } from "./seed";

/**
 * The header's line changes: `+N −M` for the working tree, parked immediately left of the git chip,
 * refreshed behind a running turn, and the way into the Tools panel's Review view. Outside a
 * repository the numbers fall back to the edits the turn itself made, read from the ACP diff hunks.
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

test.describe("header line changes", () => {
  test("sit between the plan chip and the git chip without a turn running", async ({ page }) => {
    await openWorkspace(page);

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
    await openWorkspace(page, {
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
    await openWorkspace(page);

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

  test("counts the agent's own edits when the workspace is not a git repository", async ({ page }) => {
    await openWorkspace(page, {
      workspace: {
        ...WORKSPACE,
        review: { ...WORKSPACE.review, isGitRepo: false, branch: null, files: [], additions: 0, deletions: 0 },
      },
      promptDelayMs: 6_000,
      promptUpdates: [
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "edit-1",
          kind: "edit",
          title: "Edit src/main.tsx",
          status: "completed",
          content: [{ type: "diff", path: "src/main.tsx", oldText: "a\nb\nc", newText: "a\nX\nY\nZ\nc" }],
        },
      ],
    });

    // No repository: the chip says so and the rail stays away until the turn edits something.
    await expect(page.getByTestId("git-chip")).toContainText("No git");
    await expect(page.getByTestId("header-diffstat")).toHaveCount(0);

    await page.getByTestId("composer-input").fill("Edit without git in the workspace.");
    await page.getByTestId("send-button").click();

    const diffstat = page.getByTestId("header-diffstat");
    await expect(diffstat).toBeVisible({ timeout: 6_000 });
    await expect(diffstat).toContainText("3");
    await expect(diffstat).toContainText("1");
    await expect(diffstat).toHaveAttribute("title", /\+\d+ −\d+ from this turn's edits \(no git here\)/);
  });

  test("stays off the row at the minimum window size", async ({ page }) => {
    await page.setViewportSize({ width: 840, height: 600 });
    await openWorkspace(page);

    await expect(page.getByTestId("header-diffstat")).toBeVisible();
    await expect(page.getByTestId("git-chip")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
