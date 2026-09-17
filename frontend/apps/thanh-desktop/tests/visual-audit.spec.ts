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
    { sessionUpdate: "tool_call", toolCallId: "read-state", kind: "read", title: "Read src/state/session.ts", rawInput: { path: "src/state/session.ts" }, status: "pending" },
    { sessionUpdate: "tool_call_update", toolCallId: "read-state", kind: "read", title: "Read src/state/session.ts", status: "completed", content: [{ type: "content", content: { type: "text", text: "export const useSessionStore = create(...);" } }] },
    { sessionUpdate: "tool_call", toolCallId: "read-chat", kind: "read", title: "Read src/ui/chat/chat-view.tsx", rawInput: { path: "src/ui/chat/chat-view.tsx" }, status: "completed", content: [{ type: "content", content: { type: "text", text: "function ChatView() { /* transcript */ }" } }] },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I found the relevant boundary. " } },
    { sessionUpdate: "tool_call", toolCallId: "run-tests", kind: "execute", title: "Run tests", rawInput: { command: "pnpm test" }, status: "pending" },
    { sessionUpdate: "tool_call_update", toolCallId: "run-tests", kind: "execute", title: "Run tests", rawInput: { command: "pnpm test" }, status: "completed", content: [{ type: "content", content: { type: "text", text: "100 tests passed" } }] },
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
  await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe("visual audit", () => {
  test("covers chat, sidebar, palette and every Settings surface", async ({ page }) => {
    await openWorkspace(page);
    await expectNoHorizontalOverflow(page);
    await expect(page.getByTestId("process-status")).toContainText("Ready");
    await expect(page.locator(".statusbar")).toHaveCount(0);
    await expect(page.getByLabel("Choose workspace folder")).toBeVisible();
    await expect(page.getByLabel("Context status")).toBeVisible();
    await expect(page.getByLabel(/Theme:/)).toHaveCount(0);
    await expect(page.getByLabel("Account")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open folder" })).toHaveCount(0);
    await expect(page.locator(".processbar-workspace")).toHaveCount(0);
    await expect(page.locator(".sidebar-connection")).toHaveCount(0);
    await expect(page.locator(".sidebar-workspace")).toHaveCount(0);
    await expect(page.locator(".session-path").first()).toContainText("/Users/thanh/projects/thanh-demo");
    await capture(page, "chat-empty");

    await page.getByPlaceholder("Ask Thanh anything…").fill("Review this project and suggest the next step.");
    await capture(page, "chat-composer");
    await page.getByLabel("Open tools panel").click();
    await expect(page.getByTestId("utility-panel")).toBeVisible();
    await expect(page.getByTestId("utility-panel")).toContainText("Review");
    await expect(page.getByTestId("utility-panel")).toContainText("Files");
    await expectNoHorizontalOverflow(page);
    await capture(page, "chat-right-panel");
    await page.getByTestId("utility-panel").getByRole("button", { name: /^Review/ }).click();
    await expect(page.getByTestId("review-view")).toBeVisible();
    await expect(page.getByTestId("review-view")).toContainText("1 files");
    await expect(page.getByTestId("review-view")).toContainText("src/main.tsx");
    await expect(page.getByTestId("diff-preview")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await capture(page, "chat-review-panel");
    await page.getByRole("button", { name: "Tools", exact: true }).click();
    await page.getByTestId("utility-panel").getByRole("button", { name: /^Files/ }).click();
    await expect(page.getByTestId("files-view")).toBeVisible();
    await page.getByRole("button", { name: "src" }).click();
    await page.getByRole("button", { name: "main.tsx" }).click();
    await expect(page.getByTestId("file-preview")).toContainText("src/main.tsx");
    await expectNoHorizontalOverflow(page);
    await capture(page, "chat-files-panel");
    await page.getByLabel("Close tools panel").click();
    await page.getByTestId("send-button").click();
    await expect(page.getByText("Mock assistant reply.")).toBeVisible();
    // Turn end writes the TUI marker and the live row goes away.
    await expect(page.locator(".session-event").last()).toContainText("Worked for");
    await expect(page.getByTestId("turn-status")).toHaveCount(0);
    await capture(page, "chat-transcript");
    await page.getByText("Read 2 files").click();
    await capture(page, "chat-activity-expanded");

    await page.getByLabel("Search everything").click();
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await capture(page, "command-palette");
    await page.keyboard.press("Escape");

    await page.getByLabel("Settings").click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Plan mode" })).toBeVisible();
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

  test("shows the live turn-status row and inline decisions without a modal", async ({ page }) => {
    await openWorkspace(page, {
      ...CONNECTED_SEED,
      promptDelayMs: 1200,
      promptUpdates: [
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Starting a long-running command." } },
        { sessionUpdate: "tool_call", toolCallId: "live-command", kind: "execute", title: "Run integration tests", rawInput: { command: "pnpm test:e2e" }, status: "pending" },
      ],
    });
    await page.getByPlaceholder("Ask Thanh anything…").fill("Run the integration tests");
    await page.getByTestId("send-button").click();
    const turnStatus = page.getByTestId("turn-status");
    await expect(turnStatus).toBeVisible();
    await expect(turnStatus).toContainText("Run pnpm test:e2e");
    await expect(turnStatus.locator(".turn-status-phase")).toHaveText(/\d/);
    await expect(turnStatus.getByRole("button", { name: "[stop]" })).toBeVisible();
    // Region order matches the TUI stack: scrollback → turn-status → prompt slot.
    const [transcriptBox, statusBox, slotBox] = await Promise.all([
      page.locator(".transcript").boundingBox(),
      turnStatus.boundingBox(),
      page.locator(".prompt-slot").boundingBox(),
    ]);
    expect(statusBox!.y).toBeGreaterThanOrEqual(transcriptBox!.y + transcriptBox!.height - 1);
    expect(slotBox!.y).toBeGreaterThanOrEqual(statusBox!.y + statusBox!.height - 1);
    // No pinned tool rail: the live activity is the row above the prompt slot.
    await expect(page.getByTestId("live-activity-rail")).toHaveCount(0);
    await page.evaluate(() => window.__thanhMock?.permission());
    await expect(page.getByTestId("inline-permission")).toBeVisible();
    // The card replaces the prompt slot rather than stacking above a live composer.
    await expect(page.locator(".prompt-slot")).toBeHidden();
    const [transcriptAfter, cardBox] = await Promise.all([
      page.locator(".transcript").boundingBox(),
      page.locator(".chat-prompt-dock").boundingBox(),
    ]);
    expect(cardBox!.y).toBeGreaterThanOrEqual(transcriptAfter!.y + transcriptAfter!.height - 1);
    await expect(page.locator(".modal-backdrop")).toHaveCount(0);
    await page.getByTestId("inline-permission").getByRole("button", { name: /Allow once/ }).click();
    await page.evaluate(() => window.__thanhMock?.plan());
    await expect(page.getByTestId("inline-interaction")).toContainText("Implementation plan");
    await expect(page.getByTestId("inline-interaction")).toContainText("Approve");
    await capture(page, "chat-turn-status-inline-decisions");
  });
});
