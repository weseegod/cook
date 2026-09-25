import { expect, test, type Page } from "@playwright/test";
import { openWorkspace, shellSeed } from "./support/harness";

/**
 * Edit and Write rows show changed code inline. A long Edit uses Show more;
 * Write opens the entire file with +N/-M in its title.
 */

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const launch = (page: Page, overrides: Record<string, unknown> = {}) => openWorkspace(page, shellSeed(overrides));

const fileLines = (count: number) => Array.from({ length: count }, (_, index) => `const value${index + 1} = ${index + 1};`);
const LONG_FILE = fileLines(30);

/** A `write` call the way the shell reports one: a pending call, then the created file's diff. */
function writeUpdates(lines: string[]) {
  return [
    {
      sessionUpdate: "tool_call",
      toolCallId: "write-1",
      kind: "write",
      title: "write",
      rawInput: { path: "src/created.ts" },
      status: "pending",
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "write-1",
      kind: "write",
      title: "write",
      status: "completed",
      content: [{ type: "diff", path: "src/created.ts", oldText: "", newText: lines.join("\n") }],
    },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Created the file." } },
  ];
}

test.describe("transcript rows", () => {
  test("opens an edit on its changed code and keeps its compact header when collapsed", async ({ page }) => {
    await launch(page, {
      promptUpdates: [
        {
          sessionUpdate: "tool_call",
          toolCallId: "edit-1",
          kind: "edit",
          title: "Edit src/main.tsx",
          rawInput: { path: "src/main.tsx" },
          status: "pending",
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "edit-1",
          kind: "edit",
          title: "Edit src/main.tsx",
          status: "completed",
          content: [{ type: "diff", path: "src/main.tsx", oldText: "a\nb\nc", newText: "a\nX\nY\nZ\nc" }],
        },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Edited the file." } },
      ],
    });
    await page.getByTestId("composer-input").fill("Edit the file.");
    await page.getByTestId("send-button").click();

    const row = page.getByTestId("tool-row-edit-1");
    await expect(row).toBeVisible();
    await expect(row.locator("summary strong")).toHaveText("Edit src/main.tsx");
    await expect(row).toHaveAttribute("open", "");
    await expect(row.locator(".diff-remove")).toContainText("-b");
    await expect(row.locator(".diff-add").first()).toContainText("+X");
    await expect(row.locator(".diff-meta")).toHaveCount(2);
    await expect(row.locator(".tool-locations")).toHaveCount(0);
    await row.locator("summary").click();
    await expect(row.locator(".row-diffstat")).toHaveCount(0);
    await expect(row.locator("summary strong")).toHaveText("Edit src/main.tsx");
    await row.locator("summary").click();
    await expect(row.locator(".row-diffstat")).toHaveCount(0);
  });

  test("opens the entire Write with line counts in its title", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 1500 });
    await launch(page, { promptUpdates: writeUpdates(LONG_FILE) });
    await page.getByTestId("composer-input").fill("Create the file.");
    await page.getByTestId("send-button").click();

    const row = page.getByTestId("tool-row-write-1");
    await expect(row).toBeVisible();
    await expect(row.locator("summary strong")).toHaveText("Creating src/created.ts");
    await expect(row.locator(".tool-detail-diff")).toBeVisible();
    await expect(row.locator(".row-diffstat")).toHaveText("+30/-0");
    await expect(row.locator("pre")).toContainText("const value30 = 30;");
    await expect(row.getByRole("button", { name: /Show more/ })).toHaveCount(0);
    expect(await row.locator("pre").evaluate((node) => node.scrollHeight <= node.clientHeight)).toBe(true);
    const scrollbars = await page.evaluate(() => ({
      chat: getComputedStyle(document.querySelector(".transcript")!).scrollbarColor,
      sidebar: getComputedStyle(document.querySelector(".session-list")!).scrollbarColor,
    }));
    expect(scrollbars.chat).toBe(scrollbars.sidebar);
    await row.locator("summary").click();
    await expect(row.locator(".tool-detail")).toBeHidden();
    await expect(row.locator(".row-diffstat")).toHaveText("+30/-0");
  });

  test("reveals the rest of a long Edit within chat", async ({ page }) => {
    const longEdit = writeUpdates(Array.from({ length: 60 }, (_, index) => `line ${index + 1}`))
      .map((update) => "kind" in update ? { ...update, kind: "edit", title: "edit" } : update);
    await launch(page, { promptUpdates: longEdit });
    await page.getByTestId("composer-input").fill("Edit the file.");
    await page.getByTestId("send-button").click();
    const row = page.getByTestId("tool-row-write-1");
    await expect(row.locator(".tool-detail")).toBeVisible();
    await expect(row.locator("pre")).not.toContainText("line 60");
    await row.getByRole("button", { name: /Show more/ }).click();
    await expect(row.locator("pre")).toContainText("line 60");
    await row.getByRole("button", { name: "Show less" }).click();
    await expect(row.locator("pre")).not.toContainText("line 60");
  });

  test("keeps a large write readable in a short chat frame", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 520 });
    await launch(page, { promptUpdates: writeUpdates(LONG_FILE) });
    await page.getByTestId("composer-input").fill("Create the file.");
    await page.getByTestId("send-button").click();

    const row = page.getByTestId("tool-row-write-1");
    await expect(row.locator(".tool-detail")).toBeVisible();
    await expect(row.locator(".row-diffstat")).toHaveText("+30/-0");
    await expect(row.getByRole("button", { name: /Show more/ })).toHaveCount(0);
    await expect(row).not.toContainText("Diff is large");
    await expect(row.locator("pre")).toContainText("const value30 = 30;");
  });

  test("reveals tool actions on hover and keyboard focus without adding a row", async ({ page }) => {
    await launch(page, { promptUpdates: writeUpdates(["export const ready = true;"]) });
    await page.getByTestId("composer-input").fill("Create a file.");
    await page.getByTestId("send-button").click();
    const row = page.getByTestId("tool-row-write-1");
    const actions = row.getByLabel("Tool actions");
    await row.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await expect(actions).toHaveCSS("opacity", "0");
    await row.hover();
    await expect(actions).toHaveCSS("opacity", "1");
    await row.getByRole("button", { name: "Copy path" }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("src/created.ts");
    await row.getByRole("button", { name: "Copy output" }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("+export const ready = true;");
    await page.mouse.move(0, 0);
    await row.locator("summary").focus();
    await page.keyboard.press("Tab");
    await expect(actions.locator("button").first()).toBeFocused();
    await expect(actions).toHaveCSS("opacity", "1");
  });

  test.describe("touch viewport", () => {
    test.use({ hasTouch: true, viewport: { width: 420, height: 780 } });

    test("keeps edit actions tappable and the long diff readable", async ({ page }) => {
      await launch(page, { promptUpdates: writeUpdates(Array.from({ length: 60 }, (_, index) => `line ${index + 1}`)) });
      const baselineWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      await page.getByTestId("composer-input").fill("Create a file.");
      await page.getByTestId("send-button").click();
      const row = page.getByTestId("tool-row-write-1");
      await expect(row.locator(".tool-actions")).toHaveCSS("opacity", "1");
      await row.getByRole("button", { name: "Copy path" }).tap();
      await expect(row.getByRole("button", { name: /Show more/ })).toHaveCount(0);
      await expect(row.locator("pre")).toContainText("line 60");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(baselineWidth);
    });
  });

  test("shows a long prompt three lines tall until the row is opened", async ({ page }) => {
    await launch(page);
    const prompt = Array.from({ length: 24 }, (_, index) => `Requirement ${index + 1}: check this surface.`).join("\n");
    await page.getByTestId("composer-input").fill(prompt);
    await page.getByTestId("send-button").click();

    const row = page.locator(".message-user");
    await expect(row).toContainText("Requirement 24: check this surface.");
    const folded = (await row.boundingBox())!;
    // `user.rs::COLLAPSED_MAX_LINES`: three lines with the ellipsis on the third.
    expect(folded.height).toBeLessThan(140);
    await expect(row.locator(".prompt-clip")).toHaveAttribute("data-folded", "true");

    const toggle = page.getByTestId("prompt-fold-toggle");
    await expect(toggle).toHaveText("Show more");
    await toggle.click();
    await expect(row.locator(".prompt-clip")).toHaveAttribute("data-folded", "false");
    expect((await row.boundingBox())!.height).toBeGreaterThan(folded.height + 40);
    await expect(toggle).toHaveText("Show less");
  });

  test("leaves a prompt that fits three lines alone", async ({ page }) => {
    await launch(page);
    await page.getByTestId("composer-input").fill("Create the file.");
    await page.getByTestId("send-button").click();

    await expect(page.locator(".message-user")).toContainText("Create the file.");
    await expect(page.getByTestId("prompt-fold-toggle")).toHaveCount(0);
  });
});
