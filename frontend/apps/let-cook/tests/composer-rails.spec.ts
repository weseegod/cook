import { expect, test, type Page } from "@playwright/test";
import { CONNECTED_SEED, seedAgent } from "./seed";

/**
 * Turn status metrics: after a finished mock turn, TPS and working-tree +N −M
 * appear on the progress status bar (mock git status is +3 / −1).
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

async function openWorkspace(page: Page) {
  await seedAgent(page, {
    ...CONNECTED_SEED,
    workspace: WORKSPACE,
    promptDelayMs: 500,
    reply: "A".repeat(200),
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.waitForFunction(() => Boolean(window.__cookMock));
  await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
}

test.describe("turn status metrics", () => {
  test("shows TPS and diffstat on the status bar after a completed reply", async ({ page }) => {
    await openWorkspace(page);

    // Dirty-tree snapshot appears as soon as the host mounts (mock review is +3 −1).
    await expect(page.getByTestId("turn-status-diffstat")).toBeVisible();
    await expect(page.getByTestId("turn-status-diffstat")).toContainText("3");
    await expect(page.getByTestId("turn-status-diffstat")).toContainText("1");
    await expect(page.getByTestId("turn-status-tps")).toHaveCount(0);

    await page.getByTestId("composer-input").fill("Say hello in a long enough reply for TPS.");
    await page.getByTestId("send-button").click();

    await expect(page.getByTestId("turn-status-tps")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("turn-status-tps")).toContainText("t/s");
    await expect(page.getByTestId("turn-status-diffstat")).toBeVisible();
    await expect(page.getByTestId("turn-status")).toBeVisible();
  });
});
