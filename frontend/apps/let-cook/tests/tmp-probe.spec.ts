import { expect, test } from "@playwright/test";
import { CONNECTED_SEED, seedAgent } from "./seed";

const SEED = {
  ...CONNECTED_SEED,
  sessions: [{ id: "session-login", title: "Fix login bug", cwd: "/tmp/cook-demo", updatedAt: "2026-09-17T10:00:00Z" }],
};

test("probe: danger button contrast and settings overflow", async ({ page }) => {
  await seedAgent(page, SEED);
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.waitForFunction(() => Boolean(window.__cookMock));

  const probe = async (label: string) => {
    const values = await page.getByTestId("delete-all-conversations").evaluate((node) => {
      const computed = getComputedStyle(node);
      const panel = node.closest(".settings-panel");
      return {
        color: computed.color,
        background: computed.backgroundColor,
        fontSize: computed.fontSize,
        panelBackground: panel ? getComputedStyle(panel).backgroundColor : "none",
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
      };
    });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    // eslint-disable-next-line no-console
    console.log(`PROBE ${label}`, JSON.stringify({ ...values, pageOverflow: overflow }));
  };

  await page.getByLabel("Settings").click();
  await page.getByRole("tab", { name: "Data Controls" }).click();
  await probe("dark");

  await page.getByRole("tab", { name: "General" }).click();
  await page.getByTestId("theme-option-light").click();
  await page.getByRole("tab", { name: "Data Controls" }).click();
  await probe("light");

  // Narrow: compare the overflow each tab adds at 390px.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const tab of ["General", "About", "Data Controls"]) {
    await page.getByRole("tab", { name: tab }).click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    // eslint-disable-next-line no-console
    console.log(`PROBE narrow ${tab}: ${overflow}`);
  }
  const detail = await page.getByTestId("delete-all-conversations").evaluate((node) => {
    const row = node.parentElement!;
    return {
      button: { width: node.getBoundingClientRect().width, scroll: node.scrollWidth },
      row: { width: row.getBoundingClientRect().width, scroll: row.scrollWidth },
      rowDisplay: getComputedStyle(row).display,
      flexWrap: getComputedStyle(row).flexWrap,
      buttonText: node.textContent,
    };
  });
  // eslint-disable-next-line no-console
  console.log("PROBE narrow detail", JSON.stringify(detail));
  expect(true).toBe(true);
});
