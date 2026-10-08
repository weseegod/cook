import { expect, test } from "@playwright/test";
import { api, callsTo, openWorkspace, shellSeed, waitForCalls, expectNoHorizontalOverflow } from "./support/harness";

/**
 * Settings → Prompts over the mock transport: the panel lists every editable prompt with its copy
 * state, edits are written as the user's copy, and Reset puts the shipped default back.
 */
const PROMPTS_SEED = shellSeed({
  promptRoot: "/home/demo/.cook/prompts",
  promptDefaults: {
    "plan/full.md": "Plan mode is active. Write the plan file first.\n",
    "plan/exit.md": "Plan mode is off.\n",
    "subagent/explore.md": "You are a fast, read-only codebase exploration agent.\n",
  },
  promptFiles: {
    "subagent/explore.md": "my own explorer text\n",
  },
});

test.describe("settings prompts", () => {
  test("lists prompt copies with their state and edits one", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, PROMPTS_SEED);

    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Prompts" }).click();

    await waitForCalls(page, "x.ai/prompts/list");
    await expect(page.getByTestId("prompt-open-plan/full.md")).toContainText("No copy");
    await expect(page.getByTestId("prompt-open-subagent/explore.md")).toContainText("Modified");
    await expect(page.getByTestId("prompts-warning")).toContainText("${...}");

    // Editing a prompt that has no user copy seeds the editor with the shipped text.
    await page.getByTestId("prompt-open-plan/full.md").click();
    await expect(page.getByTestId("prompt-text")).toContainText("Plan mode is active");
    await page.getByTestId("prompt-edit").click();
    await expect(page.getByTestId("prompt-editor")).toHaveValue("Plan mode is active. Write the plan file first.\n");
    await page.getByTestId("prompt-editor").fill("my plan reminder\n");
    await page.getByTestId("prompt-save").click();

    const writes = await waitForCalls(page, "x.ai/prompts/write");
    expect(writes[0].params).toEqual({ relative: "plan/full.md", content: "my plan reminder\n" });
    await expect(page.getByTestId("prompt-status")).toContainText("Saved");
    await expect(page.getByTestId("prompt-reset")).toBeEnabled();

    const files = (await mock.state()).promptFiles as Record<string, string>;
    expect(files["plan/full.md"]).toBe("my plan reminder\n");
    await expectNoHorizontalOverflow(page);
  });

  test("resets a modified copy after confirming", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, PROMPTS_SEED);

    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Prompts" }).click();
    await waitForCalls(page, "x.ai/prompts/list");

    await page.getByTestId("prompt-open-subagent/explore.md").click();
    await expect(page.getByTestId("prompt-text")).toContainText("my own explorer text");
    await page.getByTestId("prompt-reset").click();

    // Nothing is written until the confirmation is accepted.
    expect(callsTo(await mock.requests(), "x.ai/prompts/restore")).toHaveLength(0);
    await page.getByTestId("prompt-reset-confirm").click();

    const resets = await waitForCalls(page, "x.ai/prompts/restore");
    expect(resets[0].params).toEqual({ relative: "subagent/explore.md" });
    await expect(page.getByTestId("prompt-status")).toContainText("Reset");

    const files = (await mock.state()).promptFiles as Record<string, string>;
    expect(files["subagent/explore.md"]).toBe("You are a fast, read-only codebase exploration agent.\n");
  });
});
