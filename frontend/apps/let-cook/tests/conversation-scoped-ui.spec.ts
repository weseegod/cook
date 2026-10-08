import { expect, test } from "@playwright/test";
import { CONNECTED_SEED } from "./seed";
import { openWorkspace, waitForCalls } from "./support/harness";

/**
 * A blocking request belongs to the conversation that raised it. The window is one conversation
 * wide, so a request for a background conversation must wait with that conversation instead of
 * painting its card over the one the user is reading.
 */

const SEED = {
  ...CONNECTED_SEED,
  // Hold the turn open so the conversation stays live while the user is somewhere else.
  promptDelayMs: 20_000,
  sessions: [
    { id: "s-alpha-new", title: "Alpha newest", cwd: "/Users/demo/projects/cook-demo", updatedAt: "2026-09-18T10:00:00Z" },
    { id: "s-beta", title: "Beta task", cwd: "/Users/demo/work/api-server", updatedAt: "2026-09-17T10:00:00Z" },
  ],
};

test("keeps a background conversation's question out of the open one", async ({ page }) => {
  await openWorkspace(page, SEED);

  await page.getByTestId("session-row-s-alpha-new").locator(".session-open").click();
  await waitForCalls(page, "session/load");
  await page.getByTestId("composer-input").fill("Start a long turn");
  await page.getByTestId("send-button").click();
  await waitForCalls(page, "session/prompt");

  // Move to the other conversation; the parked agent then asks alpha's question.
  await page.getByTestId("session-row-s-beta").locator(".session-open").click();
  await waitForCalls(page, "session/load", 2);
  await page.evaluate(() => void window.__cookMock!.question({ sessionId: "s-alpha-new" }));

  // The open conversation keeps its composer: the card is not painted here.
  await expect(page.getByTestId("inline-interaction")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeVisible();

  // Alpha's row reports what it is waiting for, and the toast offers to go there.
  await expect(page.getByTestId("session-row-s-alpha-new").getByTestId("session-turn-status"))
    .toContainText("Needs input");
  const toast = page.getByTestId("toast-stack");
  await expect(toast).toContainText("A question is waiting");
  await toast.getByRole("button", { name: "Open" }).click();

  // Opening it restores the card the agent is still parked on.
  const card = page.getByTestId("inline-interaction");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("question-label")).toContainText("Which approach should I use?");
  // Back on screen the row reports the live phase it is blocked in.
  await expect(page.getByTestId("session-row-s-alpha-new").getByTestId("session-turn-status"))
    .toContainText("Waiting on answers for");
});
