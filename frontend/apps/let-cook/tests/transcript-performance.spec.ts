import { expect, test } from "@playwright/test";
import { openWorkspace, shellSeed } from "./support/harness";

const historyUpdates = Array.from({ length: 120 }, (_, index) => [
  {
    sessionUpdate: "user_message_chunk",
    messageId: `history-user-${index}`,
    content: { type: "text", text: `History question ${index}` },
  },
  {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `History answer ${index}` },
  },
]).flat();

test("a live turn keeps a bounded transcript while reading old messages", async ({ page }) => {
  await openWorkspace(page, shellSeed({ historyUpdates, promptDelayMs: 10_000 }));
  await page.getByTestId("session-row-session-login").locator(".session-open").click();
  await expect(page.locator(".transcript-row")).toHaveCount(40);

  await page.getByTestId("composer-input").fill("Continue the conversation");
  await page.getByTestId("send-button").click();
  await expect(page.locator(".message-assistant").last()).toContainText("Mock assistant reply.");
  await page.locator(".transcript").evaluate((element) => { element.scrollTop = 0; });
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();

  await expect.poll(() => page.locator(".transcript-row").count()).toBeLessThan(50);
  await expect(page.locator(".message-assistant").last()).toContainText("Mock assistant reply.");
  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect(page.locator(".message-user").last()).toContainText("Continue the conversation");
});

test("opening another conversation resets follow mode and row measurements", async ({ page }) => {
  await openWorkspace(page, shellSeed({ historyUpdates }));
  await page.getByTestId("session-row-session-login").locator(".session-open").click();
  await expect(page.locator(".transcript-row")).toHaveCount(40);
  await page.locator(".transcript").evaluate((element) => { element.scrollTop = 0; });
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();

  await page.getByTestId("session-row-session-providers").locator(".session-open").click();
  await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
  await expect(page.locator(".message-assistant").last()).toContainText("History answer 119");
});
