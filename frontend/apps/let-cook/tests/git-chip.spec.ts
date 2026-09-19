import { expect, test, type Page } from "@playwright/test";
import { CONNECTED_SEED } from "./seed";
import { WORKSPACE, api, capture, openWorkspace } from "./support/harness";

/**
 * The header git chip: a dirty tree shows a Git icon whose hover/click menu offers "Commit" and
 * "Commit and push". Both items send the slash command the agent expands, so the suite reads the
 * request the renderer put on the wire rather than trusting that the menu looked right.
 */

const DIRTY_SEED = { ...CONNECTED_SEED, workspace: WORKSPACE };
/** Two projects in one conversation list: the one the window connected to, and one with no git. */
const TWO_PROJECTS_SEED = {
  ...CONNECTED_SEED,
  sessions: [
    { id: "s-here", title: "Here", cwd: "/tmp/cook-demo", updatedAt: "2026-09-18T10:00:00Z" },
    { id: "s-elsewhere", title: "Elsewhere", cwd: "/Users/demo/work/api-server", updatedAt: "2026-09-17T10:00:00Z" },
  ],
  workspace: {
    ...WORKSPACE,
    byCwd: {
      "/Users/demo/work/api-server": {
        base: "HEAD",
        isGitRepo: false,
        branch: null,
        files: [],
        additions: 0,
        deletions: 0,
      },
    },
  },
};

/** The text of every `session/prompt` the renderer sent, in order. */
async function prompts(page: Page): Promise<string[]> {
  const entries = (await api(page).requests()).filter((entry) => entry.method === "session/prompt");
  return entries.map((entry) =>
    ((entry.params.prompt ?? []) as Array<{ type: string; text?: string }>)
      .map((part) => part.text ?? "")
      .join(""),
  );
}

test.describe("header git chip", () => {
  test("appears for a dirty tree and sends the commit command the menu names", async ({ page }) => {
    await openWorkspace(page, DIRTY_SEED);

    const chip = page.getByTestId("git-chip");
    await expect(chip).toBeVisible();
    await expect(page.getByTestId("git-chip-count")).toHaveText("1");

    // Hover is enough to reveal the two actions.
    await chip.hover();
    const menu = page.getByTestId("git-chip-menu");
    await expect(menu).toBeVisible();
    await expect(page.getByTestId("git-commit")).toContainText("Commit");
    await expect(page.getByTestId("git-commit-and-push")).toContainText("Commit and push");
    await capture(page, "git-chip-hover");

    await page.getByTestId("git-commit").click();

    await expect.poll(async () => (await prompts(page)).at(-1)).toBe("/commit");
    await expect(menu).toHaveCount(0);
  });

  test("keeps the chip and its menu inside a narrow window", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openWorkspace(page, DIRTY_SEED);

    const chip = page.getByTestId("git-chip");
    await expect(chip).toBeVisible();
    await chip.click();

    const menu = await page.getByTestId("git-chip-menu").boundingBox();
    expect(menu).not.toBeNull();
    expect(menu!.x).toBeGreaterThanOrEqual(0);
    expect(menu!.x + menu!.width).toBeLessThanOrEqual(390);
    await capture(page, "git-chip-narrow");
  });

  test("re-reads the workspace when a conversation from another project is opened", async ({ page }) => {
    await openWorkspace(page, TWO_PROJECTS_SEED);

    const chip = page.getByTestId("git-chip");
    await expect(chip).toContainText("main");

    // The conversation lives in a folder with no repository, so the chip has to describe that tree
    // rather than the one the window connected to.
    await page.getByTestId("session-row-s-elsewhere").locator(".session-open").click();
    await expect(chip).toContainText("No git");
    await expect(page.getByTestId("header-diffstat")).toHaveCount(0);

    // And back: the branch of the first project returns with the conversation.
    await page.getByTestId("session-row-s-here").locator(".session-open").click();
    await expect(chip).toContainText("main");
  });
});
