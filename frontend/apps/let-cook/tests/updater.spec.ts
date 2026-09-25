import { expect, test } from "@playwright/test";
import { CONNECTED_SEED } from "./seed";
import { openWorkspace } from "./support/harness";

test("shows and focuses the local update preview by default", async ({ page }) => {
  await openWorkspace(page, CONNECTED_SEED);
  await page.getByLabel("Settings").click();
  await page.getByRole("tab", { name: "About" }).click();
  const settingsPanel = page.locator(".settings-panel");
  await expect(settingsPanel).not.toContainText("Auto-update is inactive");
  await expect(settingsPanel).not.toContainText("macOS builds for this fork");

  const installButton = page.getByRole("button", { name: "Install and update" });
  await expect(installButton).toBeVisible();
  await expect(installButton).toBeFocused();
  await expect(page.locator(".about-updates button")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Check for updates" })).toHaveCount(0);

  await page.keyboard.press("Enter");
  await expect(installButton).toBeVisible();
  await expect(installButton).toBeFocused();

  await page.getByRole("tab", { name: "Data Controls" }).click();
  await expect(settingsPanel).not.toContainText("Conversations and their plan files are stored on this machine");
  await expect(page.getByTestId("delete-all-conversations")).toBeVisible();
});
