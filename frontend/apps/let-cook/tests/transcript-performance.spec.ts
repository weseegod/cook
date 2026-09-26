import { expect, test, type Page } from "@playwright/test";
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

async function streamChunks(page: Page, count: number, prefix: string) {
  for (let index = 0; index < count; index += 1) {
    await page.evaluate(
      ({ n, text }) => {
        window.__cookMock!.sessionUpdate("session-login", {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `${text}${n}` },
        });
      },
      { n: index, text: prefix },
    );
    await page.waitForTimeout(30);
  }
}

async function bottomGap(page: Page) {
  return page.locator(".transcript").evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  );
}

async function topVisibleRowId(page: Page) {
  return page.locator(".transcript").evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    for (const row of element.querySelectorAll(".transcript-row")) {
      const box = row.getBoundingClientRect();
      if (box.bottom > top + 1) return row.getAttribute("data-transcript-row");
    }
    return null;
  });
}

test("stays pinned to the bottom while a live turn streams", async ({ page }) => {
  await openWorkspace(page, shellSeed({ historyUpdates, promptDelayMs: 12_000 }));
  await page.getByTestId("session-row-session-login").locator(".session-open").click();
  await expect(page.locator(".transcript-row")).toHaveCount(40);

  await page.getByTestId("composer-input").fill("Continue the conversation");
  await page.getByTestId("send-button").click();
  await expect(page.locator(".message-assistant").last()).toContainText("Mock assistant reply.");

  const scrollTops: number[] = [];
  const gaps: number[] = [];
  for (let index = 0; index < 10; index += 1) {
    await streamChunks(page, 1, `\n\nStreaming paragraph ${index} into the live tail. `);
    scrollTops.push(await page.locator(".transcript").evaluate((element) => element.scrollTop));
    gaps.push(await bottomGap(page));
  }

  for (let index = 1; index < scrollTops.length; index += 1) {
    expect(scrollTops[index]).toBeGreaterThanOrEqual(scrollTops[index - 1] - 1);
  }
  for (const gap of gaps) {
    expect(gap).toBeLessThan(4);
  }
});

test("holds the top row while reading back as the tail streams", async ({ page }) => {
  await openWorkspace(page, shellSeed({ historyUpdates, promptDelayMs: 12_000 }));
  await page.getByTestId("session-row-session-login").locator(".session-open").click();
  await page.getByTestId("composer-input").fill("Continue the conversation");
  await page.getByTestId("send-button").click();
  await expect(page.locator(".message-assistant").last()).toContainText("Mock assistant reply.");

  await page.locator(".transcript").evaluate((element) => { element.scrollTop = 0; });
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();

  const before = await topVisibleRowId(page);
  expect(before).toBeTruthy();

  await streamChunks(page, 8, "\n\nGrow the live tail while the user reads history. ");

  const after = await topVisibleRowId(page);
  expect(after).toBe(before);
});
