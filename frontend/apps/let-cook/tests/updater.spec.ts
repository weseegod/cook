import { expect, test } from "@playwright/test";
import { CONNECTED_SEED } from "./seed";
import { openWorkspace } from "./support/harness";

test("shows an update banner outside the sidebar on open", async ({ page }) => {
  await openWorkspace(page, CONNECTED_SEED);
  const banner = page.getByTestId("update-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("-local");
  await expect(page.locator(".sidebar .update-banner")).toHaveCount(0);
  expect(await banner.evaluate((el) => Boolean(el.closest(".sidebar")))).toBe(false);

  await banner.getByRole("button", { name: "Install and update" }).click();
  await expect(banner).toBeVisible();
  await expect(banner.getByRole("button", { name: "Install and update" })).toBeVisible();
});

test("shows and focuses the local update preview by default", async ({ page }) => {
  await openWorkspace(page, CONNECTED_SEED);
  await page.getByLabel("Settings").click();
  await page.getByRole("tab", { name: "About" }).click();
  const settingsPanel = page.locator(".settings-panel");
  await expect(settingsPanel).not.toContainText("Auto-update is inactive");
  await expect(settingsPanel).not.toContainText("macOS builds for this fork");

  const installButton = settingsPanel.getByRole("button", { name: "Install and update" });
  await expect(installButton).toBeVisible();
  await expect(installButton).toBeFocused();
  await expect(page.locator(".about-updates button")).toHaveCount(1);
  await expect(settingsPanel.getByRole("button", { name: "Check for updates" })).toHaveCount(0);

  await page.keyboard.press("Enter");
  await expect(installButton).toBeVisible();
  await expect(installButton).toBeFocused();

  await page.getByRole("tab", { name: "Data Controls" }).click();
  await expect(settingsPanel).not.toContainText("Conversations and their plan files are stored on this machine");
  await expect(page.getByTestId("delete-all-conversations")).toBeVisible();
});
