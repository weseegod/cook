import { expect, test } from "@playwright/test";

test("chooses a workspace and opens a conversation", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Build with Thanh" })).toBeVisible();
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(page.getByRole("button", { name: "New conversation" })).toBeVisible();
  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(page.getByRole("heading", { name: "What should we work on?" })).toBeVisible();
  await expect(page.getByPlaceholder("Ask Thanh anything…")).toBeVisible();
});
