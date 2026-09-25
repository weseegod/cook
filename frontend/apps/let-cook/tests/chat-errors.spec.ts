import { expect, test } from "@playwright/test";
import { CONNECTED_SEED } from "./seed";
import { openConversation } from "./support/harness";

test("wraps long chat errors within the chat column", async ({ page }) => {
  await openConversation(page, CONNECTED_SEED);
  await page.evaluate(async (message) => {
    const { useSessionStore } = await import("/src/state/session.ts");
    useSessionStore.getState().set({ error: message });
  }, JSON.stringify({
    code: -32603,
    data: { message: `tool-call budget exceeded: tool call 0 buffered ${"x".repeat(520)} bytes of arguments, past the 32768 byte per-call limit` },
  }));

  const banner = page.getByTestId("chat-error");
  const message = banner.locator(".error-copy span");
  await expect(banner).toBeVisible();

  for (const width of [1280, 420]) {
    await page.setViewportSize({ width, height: 900 });
    const bannerBounds = await banner.boundingBox();
    const chatBounds = await page.locator(".main-column").boundingBox();
    const textOverflows = await message.evaluate((element) => element.scrollWidth > element.clientWidth);

    expect(bannerBounds).not.toBeNull();
    expect(chatBounds).not.toBeNull();
    expect(bannerBounds!.x).toBeGreaterThanOrEqual(chatBounds!.x - 1);
    expect(bannerBounds!.x + bannerBounds!.width).toBeLessThanOrEqual(chatBounds!.x + chatBounds!.width + 1);
    expect(textOverflows).toBe(false);
  }
});
