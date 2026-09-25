import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, openConversation, shellSeed } from "./support/harness";

/** Enough provider/model rows that the picker must scroll instead of painting past its box. */
const DENSE_PROVIDERS = [
  {
    id: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiBackend: "chat_completions",
    apiKey: "sk-mock-0123456789abcdef",
    models: [
      {
        id: "gpt-6-luna",
        name: "GPT-6-Luna",
        input: ["text"],
        supportsReasoningEffort: true,
        reasoningEfforts: [
          { id: "low", value: "low", label: "Low", description: "Fast" },
          { id: "high", value: "high", label: "High", description: "Deep", default: true },
        ],
      },
      {
        id: "gpt-6-sol",
        name: "GPT-6-Sol",
        input: ["text"],
        supportsReasoningEffort: true,
        reasoningEfforts: [{ id: "high", value: "high", label: "High", description: "Deep", default: true }],
      },
      { id: "gpt-5.6-luna", name: "gpt-5.6-luna", input: ["text"] },
    ],
  },
  {
    id: "xiaomi",
    baseUrl: "https://api.xiaomimimo.com/v1",
    apiBackend: "chat_completions",
    apiKey: "sk-mi-mock",
    models: [
      { id: "mimo-v2.6-pro", name: "Mimo V2.6 Pro", input: ["text"] },
      { id: "mimo-v2.6-flash", name: "Mimo V2.6 Flash", input: ["text"] },
    ],
  },
  {
    id: "local",
    baseUrl: "http://thanhpc:8080/v1",
    apiBackend: "chat_completions",
    apiKey: "sk-local-mock",
    models: [{ id: "local/bonsai2-27b", name: "Bonsai2 27B", input: ["text"] }],
  },
  {
    id: "deepseek",
    baseUrl: "https://api.deepseek.com",
    apiBackend: "chat_completions",
    apiKey: "sk-ds-mock",
    models: [
      { id: "deepseek-chat", name: "DeepSeek Chat", input: ["text"] },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner", input: ["text"] },
    ],
  },
  {
    id: "tokenharbor",
    baseUrl: "https://tokenharbor.ai/v1",
    apiBackend: "chat_completions",
    apiKey: "thk-mock",
    models: [
      { id: "th-fast", name: "TokenHarbor Fast", input: ["text"] },
      { id: "th-long", name: "TokenHarbor Long", input: ["text"] },
    ],
  },
  {
    id: "together",
    baseUrl: "https://api.together.xyz/v1",
    apiBackend: "chat_completions",
    apiKey: "sk-tg-mock",
    models: [
      { id: "extra-1", name: "Extra One", input: ["text"] },
      { id: "extra-2", name: "Extra Two", input: ["text"] },
    ],
  },
  {
    id: "fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiBackend: "chat_completions",
    apiKey: "sk-fw-mock",
    models: [{ id: "extra-3", name: "Extra Three", input: ["text"] }],
  },
];

const DENSE_SEED = shellSeed({
  providers: DENSE_PROVIDERS,
  defaultModel: "gpt-6-luna",
});

test("model picker list scrolls instead of painting past the menu box", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openConversation(page, DENSE_SEED);

  await page.locator(".composer-model-trigger").click();
  const menu = page.locator(".composer-model-picker-menu");
  await expect(menu).toBeVisible();
  await expect(page.locator("[data-model-picker-item]")).toHaveCount(13);

  const box = await menu.boundingBox();
  const list = page.locator(".composer-model-picker-list");
  const listBox = await list.boundingBox();
  expect(box).not.toBeNull();
  expect(listBox).not.toBeNull();
  // The scroll region is inside the menu and actually scrolls.
  expect(listBox!.height).toBeLessThanOrEqual(box!.height + 1);
  const scrollable = await list.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  expect(scrollable).toBe(true);
  const scrollbar = await list.evaluate((el) => ({
    width: getComputedStyle(el, "::-webkit-scrollbar").width,
    radius: getComputedStyle(el, "::-webkit-scrollbar-thumb").borderRadius,
  }));
  expect(scrollbar).toEqual({ width: "8px", radius: "999px" });

  await page.mouse.move(listBox!.x + listBox!.width / 2, listBox!.y + listBox!.height / 2);
  await page.mouse.wheel(0, 360);
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  // Nothing of the menu/list paints outside the viewport.
  const overflow = await page.evaluate(() => {
    const menuEl = document.querySelector(".composer-model-picker-menu");
    const listEl = document.querySelector(".composer-model-picker-list");
    if (!menuEl || !listEl) return { menu: 0, list: 0 };
    const m = menuEl.getBoundingClientRect();
    const l = listEl.getBoundingClientRect();
    return {
      menu: Math.max(0, m.bottom - window.innerHeight, m.right - window.innerWidth, -m.left, -m.top),
      list: Math.max(0, l.bottom - window.innerHeight, l.right - window.innerWidth),
    };
  });
  expect(overflow.menu).toBeLessThanOrEqual(1);
  expect(overflow.list).toBeLessThanOrEqual(1);
  await expectNoHorizontalOverflow(page);

  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 420, height: 800 });
  await page.locator(".composer-model-trigger").click();
  await expect(menu).toBeVisible();
  const narrowMenuBox = (await menu.boundingBox())!;
  const narrowListBox = (await list.boundingBox())!;
  expect(narrowMenuBox.x).toBeGreaterThanOrEqual(0);
  expect(narrowMenuBox.x + narrowMenuBox.width).toBeLessThanOrEqual(420 + 1);
  await page.mouse.move(narrowListBox.x + narrowListBox.width / 2, narrowListBox.y + narrowListBox.height / 2);
  await page.mouse.wheel(0, 360);
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

test("reasoning submenu flips left near the window edge and stays on screen", async ({ page }) => {
  // Narrow enough that menu (290) + submenu (160) cannot both sit to the right of the row.
  await page.setViewportSize({ width: 420, height: 800 });
  await openConversation(page, DENSE_SEED);

  await page.locator(".composer-model-trigger").click();
  const rows = page.locator("[data-model-picker-row]");
  await expect(rows.first()).toBeVisible();
  const lastReasoning = page.locator("[data-model-picker-row]").filter({
    has: page.locator("[data-model-picker-item] svg.lucide-chevron-right"),
  }).last();
  await lastReasoning.hover();

  const submenu = page.locator(".composer-model-picker-submenu");
  await expect(submenu).toBeVisible();
  const sub = await submenu.boundingBox();
  expect(sub).not.toBeNull();
  expect(sub!.x).toBeGreaterThanOrEqual(0);
  expect(sub!.x + sub!.width).toBeLessThanOrEqual(420 + 1);
  expect(sub!.y).toBeGreaterThanOrEqual(0);
  expect(sub!.y + sub!.height).toBeLessThanOrEqual(800 + 1);

  // Flip: when a rightward placement would overflow, the submenu's right edge stays at or
  // left of its row (it may still be clamped into the left gutter).
  const rowBox = await lastReasoning.boundingBox();
  const fitsRight = rowBox!.x + rowBox!.width + 3 + sub!.width <= 420 - 6;
  if (!fitsRight) {
    expect(sub!.x + sub!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width + 1);
  }

  await submenu.hover();
  await expect(lastReasoning).toHaveClass(/hovered/);
  const highlightedBackground = await lastReasoning.locator("[data-model-picker-item]").evaluate((element) =>
    getComputedStyle(element).backgroundColor,
  );
  expect(highlightedBackground).not.toBe("rgba(0, 0, 0, 0)");
});

test("keyboard still moves between model rows and the portaled reasoning submenu", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openConversation(page, DENSE_SEED);

  await page.locator(".composer-model-trigger").click();
  const first = page.locator("[data-model-picker-item]").filter({ hasText: "GPT-6-Luna" }).first();
  await first.focus();
  await page.keyboard.press("ArrowRight");
  const firstEffort = page.locator("[data-model-picker-effort-item]").first();
  await expect(firstEffort).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(first).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".composer-model-picker-menu")).toHaveCount(0);
  await expect(page.locator(".composer-model-picker-submenu")).toHaveCount(0);
});
