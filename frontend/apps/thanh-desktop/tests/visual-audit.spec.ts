import { expect, test, type Page } from "@playwright/test";
import { CONNECTED_SEED, seedAgent } from "./seed";

const VISUAL_SEED = {
  ...CONNECTED_SEED,
  sessions: [
    { id: "session-long", title: "Investigate the authentication flow and document the regression", cwd: "/Users/thanh/projects/thanh-demo", updatedAt: "2026-09-17T10:00:00Z" },
    { id: "session-login", title: "Fix login bug", cwd: "/Users/thanh/projects/thanh-demo", updatedAt: "2026-09-15T10:00:00Z" },
    { id: "session-providers", title: "Provider settings", cwd: "/Users/thanh/projects/thanh-demo", updatedAt: "2026-09-14T10:00:00Z" },
  ],
  promptUpdates: [
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I’ll inspect the relevant files first." } },
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Finding the state boundary and current renderer." } },
    { sessionUpdate: "tool_call", toolCallId: "read-state", kind: "read", title: "Read src/state/session.ts", status: "pending" },
    { sessionUpdate: "tool_call_update", toolCallId: "read-state", kind: "read", title: "Read src/state/session.ts", status: "completed", content: [{ type: "content", content: { type: "text", text: "export const useSessionStore = create(...);" } }] },
    { sessionUpdate: "tool_call", toolCallId: "read-chat", kind: "read", title: "Read src/ui/chat/chat-view.tsx", status: "completed", content: [{ type: "content", content: { type: "text", text: "function ChatView() { /* transcript */ }" } }] },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "## Result\n\nMock assistant " } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reply. The stream remains one message while tool activity stays compact." } },
  ],
};

const capture = async (page: Page, name: string) => {
  if (process.env.PW_CAPTURE === "1") {
    await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
  }
};

async function openWorkspace(page: Page, seed = VISUAL_SEED) {
  await seedAgent(page, seed);
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.waitForFunction(() => Boolean(window.__thanhMock));
  await expect(page.getByRole("button", { name: "New conversation" })).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe("visual audit", () => {
  test("covers chat, sidebar, palette and every Settings surface", async ({ page }) => {
    await openWorkspace(page);
    await expectNoHorizontalOverflow(page);
    await capture(page, "chat-empty");

    await page.getByPlaceholder("Ask Thanh anything…").fill("Review this project and suggest the next step.");
    await capture(page, "chat-composer");
    await page.getByTestId("send-button").click();
    await expect(page.getByText("Mock assistant reply.")).toBeVisible();
    await capture(page, "chat-transcript");
    await page.getByText("Read 2 files").click();
    await capture(page, "chat-activity-expanded");

    await page.getByLabel("Command palette").click();
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await capture(page, "command-palette");
    await page.keyboard.press("Escape");

    await page.getByLabel("Settings").click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    for (const tab of ["General", "Providers", "Models", "Connectors", "Memory & project", "Skills", "About"]) {
      await page.getByRole("tab", { name: tab }).click();
      if (tab === "Providers") await expect(page.getByTestId("provider-row-openai")).toBeVisible();
      if (tab === "Connectors") await expect(page.getByTestId("connector-filesystem")).toBeVisible();
      if (tab === "Skills") await expect(page.getByTestId("skill-help")).toBeVisible();
      await capture(page, `settings-${tab.toLowerCase().replaceAll(" ", "-")}`);
      await expectNoHorizontalOverflow(page);
    }
    await page.getByRole("tab", { name: "General" }).click();
    await page.getByTestId("theme-option-light").click();
    await capture(page, "settings-general-light");
    await page.getByTestId("theme-option-dark").click();
    await capture(page, "settings-general-dark");
  });

  test("keeps the redesigned shell usable at the minimum window size", async ({ page }) => {
    await page.setViewportSize({ width: 840, height: 600 });
    await openWorkspace(page);
    await expect(page.getByPlaceholder("Ask Thanh anything…")).toBeVisible();
    await expect(page.getByTestId("send-button")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await capture(page, "minimum-chat");

    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Providers" }).click();
    await expect(page.getByTestId("provider-row-openai")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await capture(page, "minimum-settings-providers");
  });

  test("keeps onboarding cards and Z.ai form within the viewport", async ({ page }) => {
    await openWorkspace(page, {});
    await expect(page.getByTestId("connect-provider")).toBeVisible();
    await capture(page, "connect-provider");
    await page.getByTestId("preset-zai").click();
    await expect(page.getByLabel("Base URL")).toHaveValue("https://api.z.ai/api/paas/v4/");
    await expectNoHorizontalOverflow(page);
    await capture(page, "connect-zai");
  });
});
