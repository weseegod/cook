import { expect, test } from "@playwright/test";
import { CONNECTED_SEED, seedAgent } from "./seed";

test("chooses a workspace and opens a conversation", async ({ page }) => {
  // A configured provider: with none, the shipped app shows the first-run connect flow instead.
  await seedAgent(page, CONNECTED_SEED);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Build with Thanh" })).toBeVisible();
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page.getByRole("heading", { name: "What should we work on?" })).toBeVisible();
  await expect(page.getByPlaceholder("Ask Thanh anything…")).toBeVisible();
});
