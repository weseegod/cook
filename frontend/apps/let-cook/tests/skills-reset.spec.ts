import { expect, test, type Page } from "@playwright/test";
import { api, callsTo, openWorkspace, shellSeed, waitForCalls } from "./support/harness";

/**
 * Settings → Skills over the mock transport: Reset restores the shipped `SKILL.md` a skill row
 * carries a copy of, and only a skill Cook ships offers it at all.
 */
const SKILLS_SEED = shellSeed({
  skillsRoot: "/home/demo/.cook/skills",
  skills: [
    {
      name: "review",
      description: "Review my changes",
      scope: "user",
      path: "/home/demo/.cook/skills/review/SKILL.md",
      enabled: true,
    },
    {
      name: "game-tilesets",
      display_name: "Game tilesets",
      description: "Generate game tilesets",
      scope: "bundled",
      path: "/home/demo/.cook/bundled/skills/game-tilesets/SKILL.md",
      enabled: true,
    },
    {
      name: "my-notes",
      description: "Notes I wrote myself",
      scope: "user",
      path: "/home/demo/.cook/skills/my-notes/SKILL.md",
      enabled: true,
    },
  ],
  skillDefaults: {
    review: "Review the change for defects.\n",
    "game-tilesets": "Generate a game tileset.\n",
  },
  skillFiles: { review: "my rewrite\n" },
  files: {
    "/home/demo/.cook/skills/review/SKILL.md": "my rewrite\n",
    "/home/demo/.cook/bundled/skills/game-tilesets/SKILL.md": "Generate a game tileset.\n",
    "/home/demo/.cook/skills/my-notes/SKILL.md": "notes I keep\n",
  },
});

async function openSkill(page: Page, name: string) {
  await page.getByLabel("Settings").click();
  await page.getByRole("tab", { name: "Skills" }).click();
  await waitForCalls(page, "x.ai/skills/list");
  await page.getByTestId(`skill-open-${name}`).click();
  await waitForCalls(page, "x.ai/skills/default");
}

test.describe("settings skills reset", () => {
  test("resets a modified copy after confirming", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, SKILLS_SEED);
    await openSkill(page, "review");

    const reads = callsTo(await mock.requests(), "x.ai/skills/default");
    expect(reads[0].params).toEqual({ name: "review", cwd: "." });

    await expect(page.getByTestId("skill-default-state")).toContainText("Modified");
    await expect(page.getByTestId("skill-reset")).toBeEnabled();

    await page.getByTestId("skill-reset").click();

    // Nothing is written until the confirmation is accepted.
    expect(callsTo(await mock.requests(), "x.ai/skills/restore")).toHaveLength(0);
    await page.getByTestId("skill-reset-confirm").click();

    const resets = await waitForCalls(page, "x.ai/skills/restore");
    expect(resets[0].params).toEqual({ name: "review", cwd: "." });
    await expect(page.getByTestId("skill-save-status")).toContainText("Reset to the shipped SKILL.md");
    await expect(page.getByTestId("skill-default-state")).toContainText("matches the shipped skill");

    const files = (await mock.state()).skillFiles as Record<string, string>;
    expect(files.review).toBe("Review the change for defects.\n");
  });

  test("offers no Reset for a skill the user wrote", async ({ page }) => {
    await openWorkspace(page, SKILLS_SEED);
    await openSkill(page, "my-notes");

    await expect(page.getByTestId("skill-prompt")).toContainText("notes I keep");
    await expect(page.getByTestId("skill-reset")).toHaveCount(0);
    await expect(page.getByTestId("skill-default-state")).toHaveCount(0);
  });

  test("disables Reset while there is no user copy to replace", async ({ page }) => {
    await openWorkspace(page, SKILLS_SEED);
    await openSkill(page, "game-tilesets");

    await expect(page.getByTestId("skill-default-state")).toContainText("No user copy");
    await expect(page.getByTestId("skill-reset")).toBeVisible();
    await expect(page.getByTestId("skill-reset")).toBeDisabled();
  });
});
