import { expect, test, type Page } from "@playwright/test";
import { CONNECTED_SEED, seedAgent } from "./seed";

/**
 * Two TUI presentation rules on the transcript: a collapsed Edit row carries its `+N/-M`
 * (`scrollback/blocks/tool/edit.rs::header_line`), and a running thinking row paints only the tail
 * of the block (`scrollback/blocks/thinking.rs::render_truncated`).
 */

const THOUGHT = [
  "First line of reasoning.",
  "Second line of reasoning.",
  "Third line of reasoning.",
  "Fourth line of reasoning.",
  "Fifth line of reasoning.",
  "Sixth line of reasoning.",
].join("\n");

async function openWorkspace(page: Page, overrides: Record<string, unknown> = {}) {
  await seedAgent(page, { ...CONNECTED_SEED, ...overrides });
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.waitForFunction(() => Boolean(window.__cookMock));
  await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
}

test.describe("transcript rows", () => {
  test("keeps a running thought to its last lines and collapses it on finish", async ({ page }) => {
    // An empty scripted reply plus a long delay: the turn stays open with nothing emitted, so the
    // thought pushed below is the only streaming block.
    await openWorkspace(page, { reply: "", promptDelayMs: 12_000 });
    await page.getByTestId("composer-input").fill("Reason about it.");
    await page.getByTestId("send-button").click();
    await expect(page.getByRole("button", { name: "[stop]" })).toBeVisible();

    await page.evaluate(
      (text) => window.__cookMock!.sessionNotification({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text },
      }),
      THOUGHT,
    );

    const thought = page.locator('[data-testid^="thinking-"]').first();
    await expect(thought).toBeVisible();
    await expect(thought.locator("strong")).toHaveText("Thinking…");
    // Running thinking is truncated to its tail: the head is gone and the `…` cue is not.
    const preview = thought.locator(".thinking-preview-text");
    await expect(preview).toContainText("Sixth line of reasoning.");
    await expect(preview).not.toContainText("First line of reasoning.");
    await expect(thought.locator(".thinking-ellipsis")).toHaveText("…");

    // Prose closes the thinking segment: the row freezes to its header with no body at all.
    await page.evaluate(() => window.__cookMock!.sessionNotification({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Answer." },
    }));
    await expect(thought.locator("strong")).toHaveText(/^Thought for /);
    await expect(thought.locator(".thinking-preview")).toHaveCount(0);
    await expect(thought.locator(".thinking-body")).toHaveCount(0);

    await thought.locator(".thinking-summary").click();
    await expect(thought.locator(".thinking-body")).toContainText("First line of reasoning.");
  });

  test("paints the edit diffstat on a collapsed row and drops it when expanded", async ({ page }) => {
    await openWorkspace(page, {
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
});
