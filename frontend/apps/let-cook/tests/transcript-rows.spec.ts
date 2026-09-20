import { expect, test, type Page } from "@playwright/test";
import { openWorkspace, shellSeed } from "./support/harness";

/**
 * A TUI presentation rule on the transcript: a collapsed Edit row carries its `+N/-M`
 * (`scrollback/blocks/tool/edit.rs::header_line`).
 *
 * One deliberate divergence: a write row opens on the file the agent just wrote instead of the
 * TUI's one-liner, and folds back when that body would not fit the chat frame it is read in.
 */

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
  test("paints the edit diffstat on a collapsed row and drops it when expanded", async ({ page }) => {
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
    await expect(row.locator(".row-diff-add")).toHaveText("+3");
    await expect(row.locator(".row-diff-del")).toHaveText("-1");

    // The diffstat belongs to the one-liner: expanding the row shows the hunks instead.
    await row.locator("summary").click();
    await expect(row.locator(".row-diffstat")).toHaveCount(0);
  });

  test("opens a write row on the created file and folds the diffstat back on click", async ({ page }) => {
    // 32 painted lines stay under the 40-line Preview hand-off, so only the frame can fold this row.
    await page.setViewportSize({ width: 1024, height: 1500 });
    await launch(page, { promptUpdates: writeUpdates(LONG_FILE) });
    await page.getByTestId("composer-input").fill("Create the file.");
    await page.getByTestId("send-button").click();

    const row = page.getByTestId("tool-row-write-1");
    await expect(row).toBeVisible();
    await expect(row.locator("summary strong")).toHaveText("Creating src/created.ts");
    // No click needed: the row already shows what the agent wrote.
    await expect(row.locator(".tool-detail-full")).toBeVisible();
    await expect(row.locator("pre")).toContainText("const value30 = 30;");
    // The open body is not a 320px box with a scrollbar of its own; the frame fit is what allowed it.
    expect(await row.locator("pre").evaluate((node) => node.scrollHeight <= node.clientHeight)).toBe(true);
    await expect(row.locator(".row-diffstat")).toHaveCount(0);

    await row.locator("summary").click();
    await expect(row.locator(".tool-detail")).toBeHidden();
    await expect(row.locator(".row-diffstat")).toHaveText("+30/-0");
  });

  test("folds a write row whose body outgrows the chat frame", async ({ page }) => {
    // The same file as the open case above, read in a window the body cannot fit.
    await page.setViewportSize({ width: 1024, height: 520 });
    await launch(page, { promptUpdates: writeUpdates(LONG_FILE) });
    await page.getByTestId("composer-input").fill("Create the file.");
    await page.getByTestId("send-button").click();

    const row = page.getByTestId("tool-row-write-1");
    await expect(row.locator("summary strong")).toHaveText("Creating src/created.ts");
    await expect(row.locator(".tool-detail")).toBeHidden();
    await expect(row.locator(".row-diffstat")).toHaveText("+30/-0");

    // Folded by the frame, not taken away: the user can still open the row by hand.
    await row.locator("summary").click();
    await expect(row.locator(".tool-detail")).toBeVisible();
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
