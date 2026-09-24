import { expect, test, type Page } from "@playwright/test";
import { openConversation, shellSeed } from "./support/harness";

async function chatWidths(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
    const main = box(".main-column");
    const composer = box(".composer");
    return {
      main: main?.width ?? 0,
      composer: composer?.width ?? 0,
      leftGutter: main && composer ? composer.left - main.left : 0,
      rightGutter: main && composer ? main.right - composer.right : 0,
      overflow: document.body.scrollWidth - window.innerWidth,
    };
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme} workbench keeps the composer fitted to chat and restores the sidebar`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem("cook.theme", value), theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openConversation(page, shellSeed());

    for (const width of [1440, 1280, 840]) {
      await page.setViewportSize({ width, height: 900 });
      const initial = await chatWidths(page);
      expect(initial.composer).toBeGreaterThanOrEqual(initial.main - 48);
      expect(initial.overflow).toBeLessThanOrEqual(0);

      await page.getByRole("button", { name: "Open tools panel" }).click();
      if (width === 840) await expect(page.locator(".sidebar")).toHaveCount(0);
      else await expect(page.locator(".sidebar")).toBeVisible();
      const withTools = await chatWidths(page);
      expect(withTools.main).toBeGreaterThanOrEqual(600);
      expect(withTools.composer).toBeGreaterThanOrEqual(withTools.main - 48);
      expect(Math.abs(withTools.leftGutter - withTools.rightGutter)).toBeLessThanOrEqual(1);
      expect(withTools.overflow).toBeLessThanOrEqual(0);

      await page.getByRole("button", { name: "Close tools panel" }).click();
      await expect(page.locator(".sidebar")).toBeVisible();
    }
  });

  test(`${theme} composer text, border and focus remain legible`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem("cook.theme", value), theme);
    await openConversation(page, shellSeed());
    await page.getByTestId("composer-input").focus();
    const contrast = await page.evaluate(() => {
      const composer = document.querySelector<HTMLElement>(".composer")!;
      const input = document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
      const surface = getComputedStyle(composer);
      const field = getComputedStyle(input);
      const placeholder = getComputedStyle(input, "::placeholder");
      const luminance = (value: string) => {
        const channels = value.match(/\d+(?:\.\d+)?/g)!.slice(0, 3).map((part) => Number(part) / 255);
        const linear = channels.map((channel) => channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4);
        return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
      };
      const ratio = (foreground: string, background: string) => {
        const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
        return (lighter + 0.05) / (darker + 0.05);
      };
      return {
        text: ratio(field.color, surface.backgroundColor),
        placeholder: ratio(placeholder.color, surface.backgroundColor),
        border: ratio(surface.borderColor, surface.backgroundColor),
        focus: ratio(surface.outlineColor, surface.backgroundColor),
        focusWidth: Number.parseFloat(surface.outlineWidth),
      };
    });
    expect(contrast.text).toBeGreaterThanOrEqual(4.5);
    expect(contrast.placeholder).toBeGreaterThanOrEqual(4.5);
    expect(contrast.border).toBeGreaterThanOrEqual(3);
    expect(contrast.focus).toBeGreaterThanOrEqual(3);
    expect(contrast.focusWidth).toBeGreaterThanOrEqual(2);
  });
}

test("prose stays readable while code uses the chat width", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openConversation(page, shellSeed({
    reply: "A short explanation of the change.\n\n```ts\nexport const answer = 42;\n```",
  }));
  await page.getByTestId("composer-input").fill("Show a code example");
  await page.getByTestId("composer-input").press("Enter");
  await expect(page.locator(".message-assistant .code-block")).toBeVisible();
  const widths = await page.evaluate(() => ({
    paragraph: document.querySelector(".message-assistant .markdown p")?.getBoundingClientRect().width ?? 0,
    code: document.querySelector(".message-assistant .code-block")?.getBoundingClientRect().width ?? 0,
  }));
  expect(widths.paragraph).toBeGreaterThan(0);
  expect(widths.code).toBeGreaterThan(widths.paragraph + 100);
});
