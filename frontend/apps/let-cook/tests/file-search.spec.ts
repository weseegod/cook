import { expect, test, type Page } from "@playwright/test";
import { CONNECTED_SEED } from "./seed";
import { openWorkspace } from "./support/harness";

const composer = (page: Page) => page.getByPlaceholder("Ask Cook anything…");

test.describe("composer @ path search", () => {
  test("lists depth-1 entries for a bare @", async ({ page }) => {
    await openWorkspace(page, CONNECTED_SEED);
    await composer(page).fill("@");
    await expect(page.getByTestId("file-search-menu")).toBeVisible();
    await expect(page.getByTestId("file-search-item").filter({ hasText: "README.md" })).toBeVisible();
    await expect(page.getByTestId("file-search-item").filter({ hasText: "src/" })).toBeVisible();
  });

  test("completes a fuzzy file match on Tab", async ({ page }) => {
    await openWorkspace(page, CONNECTED_SEED);
    await composer(page).fill("@mai");
    await expect(page.getByTestId("file-search-menu")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(composer(page)).toHaveValue("@src/main.tsx ");
  });

  test("keeps the menu open after accepting a directory in dir-mode", async ({ page }) => {
    await openWorkspace(page, CONNECTED_SEED);
    await composer(page).fill("@src/");
    await expect(page.getByTestId("file-search-menu")).toBeVisible();
    const dir = page.getByTestId("file-search-item").filter({ hasText: /^src\/$/ });
    await dir.hover();
    await page.keyboard.press("Enter");
    await expect(composer(page)).toHaveValue("@src/");
    await expect(page.getByTestId("file-search-menu")).toBeVisible();
    await expect(page.getByTestId("file-search-item").filter({ hasText: "main.tsx" })).toBeVisible();
  });

  test("does not open for an email-like token", async ({ page }) => {
    await openWorkspace(page, CONNECTED_SEED);
    await composer(page).fill("user@ex");
    await expect(page.getByTestId("file-search-menu")).toHaveCount(0);
  });

  test("Esc dismisses without blocking a later Enter submit", async ({ page }) => {
    await openWorkspace(page, CONNECTED_SEED);
    await composer(page).fill("@");
    await expect(page.getByTestId("file-search-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("file-search-menu")).toHaveCount(0);
    await composer(page).fill("hello from esc");
    await page.keyboard.press("Enter");
    await expect(page.getByText("hello from esc")).toBeVisible();
  });

  test("opens for an @ token in the middle of a sentence", async ({ page }) => {
    await openWorkspace(page, CONNECTED_SEED);
    await composer(page).fill("look at @READ");
    await expect(page.getByTestId("file-search-menu")).toBeVisible();
    await expect(page.getByTestId("file-search-item").filter({ hasText: "README.md" })).toBeVisible();
  });
});
