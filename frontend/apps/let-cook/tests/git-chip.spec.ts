import { expect, test, type Page } from "@playwright/test";
import { CONNECTED_SEED, seedAgent } from "./seed";

/**
 * The header git chip: a dirty tree shows a Git icon whose hover/click menu offers "Commit" and
 * "Commit and push". Both items send the slash command the agent expands, so the suite reads the
 * request the renderer put on the wire rather than trusting that the menu looked right.
 */

/** The mock workspace, whose seeded review is the source of the chip's dirty-tree summary. */
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

const DIRTY_SEED = { ...CONNECTED_SEED, workspace: WORKSPACE };
const CLEAN_SEED = {
  ...CONNECTED_SEED,
  workspace: {
    ...WORKSPACE,
    review: { ...WORKSPACE.review, files: [], additions: 0, deletions: 0 },
  },
};
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

type Recorded = { method: string; params: Record<string, unknown>; at: number };

function api(page: Page) {
  return {
    requests: (): Promise<Recorded[]> => page.evaluate(() => window.__cookMock!.requests()),
  };
}

/** The text of every `session/prompt` the renderer sent, in order. */
async function prompts(page: Page): Promise<string[]> {
  const entries = (await api(page).requests()).filter((entry) => entry.method === "session/prompt");
  return entries.map((entry) =>
    ((entry.params.prompt ?? []) as Array<{ type: string; text?: string }>)
      .map((part) => part.text ?? "")
      .join(""),
  );
}

/** Settings and its confirmation are fixed overlays, so the viewport is the frame that shows them. */
const capture = async (page: Page, name: string) => {
  if (process.env.PW_CAPTURE === "1") {
    await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  }
};

async function openWorkspace(page: Page, seed: Record<string, unknown> = DIRTY_SEED) {
  await seedAgent(page, seed);
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.waitForFunction(() => Boolean(window.__cookMock));
  await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
}

test.describe("header git chip", () => {
  test("appears for a dirty tree and sends the commit command the menu names", async ({ page }) => {
    await openWorkspace(page);

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

  test("commits and pushes through the second menu item", async ({ page }) => {
    await openWorkspace(page);

    await page.getByTestId("git-chip").click();
    await page.getByTestId("git-commit-and-push").click();

    await expect.poll(async () => (await prompts(page)).at(-1)).toBe("/commit-and-push");
  });

  test("names the branch and disables the commands while the tree is clean", async ({ page }) => {
    await openWorkspace(page, CLEAN_SEED);

    const chip = page.getByTestId("git-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("main");
    await expect(page.getByTestId("git-chip-count")).toHaveCount(0);
    await expect(chip).toHaveAttribute("title", "Clean tree on main");

    await chip.click();
    await expect(page.getByTestId("git-commit")).toBeDisabled();
    await expect(page.getByTestId("git-commit-and-push")).toBeDisabled();
    await capture(page, "git-chip-clean");

    // The header remains intact; context usage now lives in the composer footer.
    await expect(page.getByTestId("agent-header")).toBeVisible();
    await expect(page.getByTestId("composer-info").getByTestId("context-chip")).toBeVisible();
  });

  test("keeps the chip and its menu inside a narrow window", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openWorkspace(page);

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
