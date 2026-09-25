import { expect, test } from "@playwright/test";
import { CONNECTED_SEED } from "./seed";
import { PNG_BASE64, api, callsTo, openWorkspace, waitForCalls } from "./support/harness";

const delayedTurn = { ...CONNECTED_SEED, promptDelayMs: 20_000 };

test("switches the running composer action between Stop and Queue", async ({ page }) => {
  const mock = api(page);
  await openWorkspace(page, delayedTurn);
  const input = page.getByTestId("composer-input");
  await input.fill("Start a long turn");
  await page.getByTestId("send-button").click();
  await waitForCalls(page, "session/prompt");

  const stop = page.getByTestId("stop-button");
  await expect(stop).toBeVisible();
  await expect(page.getByTestId("turn-status").getByRole("button", { name: "Stop" })).toHaveCount(0);
  await input.fill("   ");
  await expect(stop).toBeVisible();
  await input.fill("Follow up");
  await expect(page.getByTestId("send-button")).toHaveText(/Queue/);
  await expect(page.getByTestId("send-button")).toBeEnabled();
  await input.fill("");
  await expect(stop).toBeVisible();

  await page.getByTestId("attach-input").setInputFiles({
    name: "follow-up.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_BASE64, "base64"),
  });
  await expect(page.getByTestId("send-button")).toHaveText(/Queue/);
  await page.getByRole("button", { name: "Remove follow-up.png" }).click();
  await expect(stop).toBeVisible();

  await input.fill("Follow up once");
  await page.getByTestId("send-button").click();
  const prompts = await waitForCalls(page, "session/prompt", 2);
  expect(prompts[1].params.prompt).toEqual([{ type: "text", text: "Follow up once" }]);
  await expect(stop).toBeVisible();
  await stop.click();
  await waitForCalls(page, "session/cancel");
  expect(callsTo(await mock.requests(), "session/cancel")).toHaveLength(1);
  await expect(page.getByTestId("send-button")).toHaveText(/Send/);
});

test("keeps Stop in the permission card while the composer is hidden", async ({ page }) => {
  const mock = api(page);
  await openWorkspace(page, delayedTurn);
  await page.getByTestId("composer-input").fill("Start a long turn");
  await page.getByTestId("send-button").click();
  await waitForCalls(page, "session/prompt");

  await page.evaluate(() => window.__cookMock!.permission());
  const permission = page.getByTestId("inline-permission");
  await expect(permission.getByTestId("stop-button")).toBeVisible();
  await expect(page.getByTestId("composer-input")).toBeHidden();
  await permission.getByTestId("stop-button").click();
  await waitForCalls(page, "session/cancel");
  expect(callsTo(await mock.requests(), "session/cancel")).toHaveLength(1);
});

test("keeps Stop in the question card while the composer is hidden", async ({ page }) => {
  await openWorkspace(page, delayedTurn);
  await page.getByTestId("composer-input").fill("Start a long turn");
  await page.getByTestId("send-button").click();
  await waitForCalls(page, "session/prompt");

  await page.evaluate(() => window.__cookMock!.question());
  const question = page.getByTestId("inline-interaction");
  await expect(question.getByTestId("stop-button")).toBeVisible();
  await expect(page.getByTestId("composer-input")).toBeHidden();
  await question.getByTestId("stop-button").click();
  await waitForCalls(page, "session/cancel");
});

test("walks multi-question tabs and submits answers in index order", async ({ page }) => {
  const mock = api(page);
  await openWorkspace(page, CONNECTED_SEED);
  const requestId = await page.evaluate(() => window.__cookMock!.question());
  const card = page.getByTestId("inline-interaction");
  await expect(card.getByTestId("question-tab-counter")).toHaveText(/1\s*\/\s*3/);
  await expect(card.getByTestId("question-label")).toContainText("Which approach should I use?");

  await card.getByTestId("question-option-0-safe").click();
  await expect(card.getByTestId("question-tab-counter")).toHaveText(/2\s*\/\s*3/);
  await card.getByTestId("question-option-1-tests").click();
  await card.getByTestId("question-option-1-docs").click();
  await card.getByTestId("question-tab-3").click();
  await expect(card.getByTestId("question-tab-counter")).toHaveText(/3\s*\/\s*3/);
  await card.getByTestId("question-option-2-staging").click();
  await expect(card.getByTestId("question-answered-hint")).toHaveText(/3\s*\/\s*3 answered/);
  await card.getByTestId("question-submit").click();

  await expect.poll(async () => (await mock.responses()).find((entry) => entry.id === requestId)?.result).toEqual({
    outcome: "accepted",
    answers: {
      "Which approach should I use?\n\nPick the strategy for this change. Prefer the safer path unless speed is mandatory.": ["Safe change"],
      "Which approach should I use?": ["Add tests", "Update docs"],
      "Where should we deploy?": ["Staging"],
    },
  });
  await expect(page.getByTestId("inline-interaction")).toHaveCount(0);
});

test("keeps special composer actions available alongside Stop", async ({ page }) => {
  await openWorkspace(page, delayedTurn);
  const input = page.getByTestId("composer-input");
  await input.fill("Start a long turn");
  await page.getByTestId("send-button").click();
  await waitForCalls(page, "session/prompt");

  await page.evaluate(() => window.__cookMock!.queueChanged([
    { id: "held", version: 0, text: "Edit me", kind: "prompt", position: 0 },
  ]));
  await page.getByTestId("queue-edit-held").click();
  await expect(page.getByTestId("send-button")).toHaveText(/Save/);
  await expect(page.getByTestId("stop-button")).toBeVisible();
  await input.press("Escape");

  await page.evaluate(() => window.__cookMock!.plan());
  await expect(page.getByTestId("send-button")).toHaveText(/Request changes/);
  await expect(page.getByTestId("stop-button")).toBeVisible();
});
