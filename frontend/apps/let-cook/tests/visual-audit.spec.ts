import { expect, test, type Page } from "@playwright/test";
import { CONNECTED_SEED, seedAgent } from "./seed";

const VISUAL_SEED = {
  ...CONNECTED_SEED,
  sessions: [
    { id: "session-long", title: "Investigate the authentication flow and document the regression", cwd: "/Users/demo/projects/cook-demo", updatedAt: "2026-09-17T10:00:00Z" },
    { id: "session-login", title: "Fix login bug", cwd: "/Users/demo/projects/cook-demo", updatedAt: "2026-09-15T10:00:00Z" },
    { id: "session-providers", title: "Provider settings", cwd: "/Users/demo/projects/cook-demo", updatedAt: "2026-09-14T10:00:00Z" },
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
  await page.waitForFunction(() => Boolean(window.__cookMock));
  await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

/** The working conversation's sidebar row paints its live status. */
async function waitForTurnStatus(page: Page) {
  await expect(page.locator(".session-row.active").getByTestId("session-turn-status")).toBeVisible();
}

test.describe("visual audit", () => {
  test("covers chat, sidebar, palette and every Settings surface", async ({ page }) => {
    await openWorkspace(page);
    await expectNoHorizontalOverflow(page);
    await expect(page.getByTestId("agent-header")).toBeVisible();
    await expect(page.getByLabel("Choose workspace folder")).toBeVisible();
    await expect(page.locator(".process-status")).toHaveCount(0);
    await expect(page.locator(".statusbar")).toHaveCount(0);
    await expect(page.getByLabel("Context status")).toBeVisible();
    await expect(page.getByLabel(/Theme:/)).toHaveCount(0);
    await expect(page.getByLabel("Account")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open folder" })).toHaveCount(0);
    await expect(page.locator(".processbar-workspace")).toHaveCount(0);
    await expect(page.locator(".sidebar-connection")).toHaveCount(0);
    await expect(page.locator(".sidebar-workspace")).toHaveCount(0);
    await expect(page.locator(".session-path").first()).toContainText("/Users/demo/projects/cook-demo");
    await capture(page, "chat-empty");

    await page.getByPlaceholder("Ask Cook anything…").fill("Review this project and suggest the next step.");
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
    for (const tab of ["General", "Models", "Connectors", "Memory & project", "Skills", "About"]) {
      await page.getByRole("tab", { name: tab }).click();
      if (tab === "Models") {
        await expect(page.getByTestId("provider-row-openai")).toBeVisible();
        await expect(page.locator("[data-testid^='provider-row-']")).toHaveCount(8);
        await expect(page.getByText("Choose a provider")).toHaveCount(0);
        await expect(page.getByText("Could not read providers from the agent.")).toHaveCount(0);
      }
      if (tab === "Connectors") {
        await expect(page.getByTestId("connector-filesystem")).toBeVisible();
        // Each server carries its tools, and each tool its own toggle.
        await expect(page.getByTestId("connector-tool-filesystem-read_file")).toBeVisible();
        await expect(page.getByLabel("Toggle tool list_dir")).toBeVisible();
      }
      if (tab === "Skills") {
        await expect(page.getByTestId("skill-help")).toBeVisible();
        await expect(page.getByTestId("skill-group-Bundled")).toBeVisible();
        await expect(page.getByLabel("Toggle skill help")).toBeVisible();
      }
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
    await expect(page.getByPlaceholder("Ask Cook anything…")).toBeVisible();
    await expect(page.getByTestId("send-button")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await capture(page, "minimum-chat");

    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Models" }).click();
    await expect(page.getByTestId("provider-row-openai")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await capture(page, "minimum-settings-models");

    // The tool and skill rows carry two lines of text plus a switch, so they are the narrowest
    // content in Settings.
    await page.getByRole("tab", { name: "Connectors" }).click();
    await expect(page.getByTestId("connector-tool-filesystem-list_dir")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await capture(page, "minimum-settings-connectors");

    await page.getByRole("tab", { name: "Skills" }).click();
    await expect(page.getByTestId("skill-help")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await capture(page, "minimum-settings-skills");
  });

  test("shows the goal chip and its detail surface in both themes", async ({ page }) => {
    await openWorkspace(page, {
      ...CONNECTED_SEED,
      promptUpdates: [
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Executing the approved plan." } },
        {
          sessionUpdate: "plan",
          entries: [
            { content: "Map the TUI goal surface", priority: "high", status: "completed" },
            { content: "Render the goal chip", priority: "high", status: "in_progress" },
            { content: "Add the completion marker", priority: "medium", status: "pending" },
            { content: "Drop the old approach", priority: "low", status: "completed", _meta: { cancelled: true } },
          ],
        },
      ],
    });
    await page.getByPlaceholder("Ask Cook anything…").fill("run the approved plan");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Executing the approved plan.")).toBeVisible();
    await expect(page.locator(".plan-card")).toHaveCount(0);
    await expect(page.getByTestId("todo-overlay")).toHaveCount(0);
    // The goal reports itself over the extension envelope, after the session exists.
    await page.evaluate(() => window.__cookMock!.sessionNotification(window.__cookMock!.goalUpdate({
      token_budget: 100_000,
      tokens_used: 25_000,
      elapsed_ms: 65_000,
      current_subagent_role: "worker",
      total_worker_rounds: 4,
      total_verify_rounds: 2,
      live_subagent_tokens: 10_000,
      live_context_pct: 35,
      live_turn_count: 3,
      live_tool_call_count: 8,
      live_tokens_by_model: [["gpt-5", 6_000], ["o4-mini", 4_000], ["deepseek-chat", 3_000]],
      last_event: "worker_completed",
      last_event_detail: "Core logic",
      classifier_runs_attempted: 1,
      classifier_max_runs: 3,
      last_classifier_verdict: "not_achieved",
      last_classifier_details_path: "/tmp/details.md",
    })));

    await expect(page.getByTestId("goal-chip")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await capture(page, "chat-goal-chip");

    await page.getByTestId("goal-chip").click();
    await expect(page.getByTestId("goal-detail")).toBeVisible();
    await expect(page.getByTestId("goal-detail").getByTestId("plan-entry-completed")).toContainText("Map the TUI goal surface");
    expect(await page.locator(".dialog").evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await capture(page, "chat-goal-detail");
    await page.keyboard.press("Escape");

    // Light theme keeps the chip, the checklist and the detail readable.
    await page.getByLabel("Settings").click();
    await page.getByTestId("theme-option-light").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("goal-chip")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await capture(page, "chat-goal-chip-light");
    await page.getByTestId("goal-chip").click();
    await expect(page.getByTestId("goal-detail")).toBeVisible();
    await capture(page, "chat-goal-detail-light");
    await page.keyboard.press("Escape");
    await page.getByLabel("Settings").click();
    await page.getByTestId("theme-option-dark").click();
    await page.keyboard.press("Escape");
  });

  test("shows the plan chip and its popup in both themes", async ({ page }) => {
    await openWorkspace(page, {
      ...CONNECTED_SEED,
      promptUpdates: [
        {
          sessionUpdate: "plan",
          entries: [
            { content: "Map the TUI plan surface", priority: "high", status: "completed" },
            { content: "Render the popup", priority: "high", status: "in_progress" },
            { content: "Anchor the comments", priority: "medium", status: "pending" },
            { content: "Drop the old card", priority: "low", status: "completed", _meta: { cancelled: true } },
          ],
        },
      ],
    });
    await page.getByPlaceholder("Ask Cook anything…").fill("show me the plan");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Mock assistant reply.").or(page.getByTestId("todo-toggle"))).toBeVisible();
    await expect(page.locator(".plan-card")).toHaveCount(0);
    await expect(page.getByTestId("todo-overlay")).toHaveCount(0);
    // The review carries the whole plan body; the popup is where it is read.
    await page.evaluate(() => window.__cookMock!.plan({
      planContent: "# Implementation plan\n\n## Steps\n\n- Update the transcript renderer\n- Verify the desktop flow\n\n> Keep the line numbers honest.",
    }));

    await expect(page.getByTestId("plan-chip")).toBeVisible();
    await expect(page.getByTestId("plan-pane")).toContainText("plan.md");
    await expectNoHorizontalOverflow(page);
    await capture(page, "chat-plan-chip");

    await page.getByTestId("dialog-hide").click();
    await expect(page.getByTestId("plan-pane")).toHaveCount(0);
    await page.getByTestId("plan-chip").click();
    await expect(page.getByTestId("plan-lines")).toBeVisible();
    expect(await page.locator(".plan-pane").evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await capture(page, "chat-plan-popup");
    await page.keyboard.press("Escape");

    // Light theme keeps the chip, the gutter and the decision bar readable.
    await page.getByLabel("Settings").click();
    await page.getByTestId("theme-option-light").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("plan-chip")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await capture(page, "chat-plan-chip-light");
    await page.getByTestId("plan-chip").click();
    await expect(page.getByTestId("plan-lines")).toBeVisible();
    await capture(page, "chat-plan-popup-light");
    await page.keyboard.press("Escape");
    await page.getByLabel("Settings").click();
    await page.getByTestId("theme-option-dark").click();
    await page.keyboard.press("Escape");
  });

  test("keeps the plan popup inside a narrow window", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openWorkspace(page, CONNECTED_SEED);
    // The shell itself overflows this viewport; only overflow the popup adds is a regression here.
    const baseline = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await page.evaluate(() => window.__cookMock!.plan());
    await expect(page.getByTestId("plan-chip")).toBeVisible();
    await expect(page.getByTestId("plan-pane")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(baseline + 1);

    const box = (await page.locator(".plan-pane").boundingBox())!;
    const main = (await page.locator(".chat-main").boundingBox())!;
    // The narrow shell keeps its desktop sidebar minimum; the pane must match the transcript
    // region exactly and must not create any additional document overflow.
    expect(box.x).toBe(main.x);
    expect(box.width).toBe(main.width);
    await expect(page.getByTestId("composer-input")).toBeVisible();
    await expect(page.getByTestId("composer-input")).toBeEnabled();
    expect(await page.locator(".plan-pane").evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await capture(page, "narrow-plan-popup");
  });

  test("keeps the goal chip inside a narrow window", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openWorkspace(page, CONNECTED_SEED);
    // The shell itself overflows this viewport; only overflow the chip adds is a regression here.
    const baseline = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await page.evaluate(() => window.__cookMock!.sessionNotification(window.__cookMock!.goalUpdate({
      status: "blocked",
      elapsed_ms: 3_600_000,
      token_budget: 100_000,
      tokens_used: 42_000,
    })));
    await expect(page.getByTestId("goal-chip")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(baseline + 1);
    await capture(page, "narrow-goal-chip");

    await page.getByTestId("goal-chip").click();
    const box = (await page.locator(".dialog").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await capture(page, "narrow-goal-detail");
  });

  test("keeps the models panel and its popups inside a narrow window", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openWorkspace(page, {
      ...CONNECTED_SEED,
      discoverable: [
        { id: "gpt-5-mini", name: "GPT-5 Mini", contextWindow: 400_000, maxCompletionTokens: 128_000 },
        { id: "gpt-4.1", name: "GPT-4.1 with a deliberately long catalogue name", contextWindow: 1_000_000 },
      ],
    });
    await page.getByLabel("Settings").click();
    // The shell itself is wider than this viewport, so compare against an untouched tab: only
    // overflow the Models surface adds is a regression here.
    await page.getByRole("tab", { name: "Connectors" }).click();
    const baseline = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await page.getByRole("tab", { name: "Models" }).click();
    await expect(page.getByTestId("provider-row-openai")).toBeVisible();
    const models = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(models).toBeLessThanOrEqual(baseline + 1);

    // A dialog is an overlay, so measure it on its own axis and inside the viewport.
    await page.getByTestId("provider-add-model-openai").click();
    await page.getByTestId("model-get-models").click();
    await expect(page.getByTestId("model-candidates")).toBeVisible();
    expect(await page.locator(".dialog").evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    const box = (await page.locator(".dialog").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await capture(page, "narrow-add-model");
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
    await page.getByPlaceholder("Ask Cook anything…").fill("Run the integration tests");
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
    await page.evaluate(() => window.__cookMock?.permission());
    await expect(page.getByTestId("inline-permission")).toBeVisible();
    // The card replaces the prompt slot rather than stacking above a live composer.
    await expect(page.locator(".prompt-composer")).toBeHidden();
    const [transcriptAfter, cardBox] = await Promise.all([
      page.locator(".transcript").boundingBox(),
      page.getByTestId("inline-permission").boundingBox(),
    ]);
    expect(cardBox!.y).toBeGreaterThanOrEqual(transcriptAfter!.y + transcriptAfter!.height - 1);
    await expect(page.locator(".modal-backdrop")).toHaveCount(0);
    await page.getByTestId("inline-permission").getByRole("button", { name: /Allow once/ }).click();
    await page.evaluate(() => window.__cookMock?.plan());
    // Plan review auto-opens the transcript pane; no inline interaction card; composer stays live
    // underneath it rather than only reappearing after Hide.
    await expect(page.getByTestId("plan-pane")).toContainText("plan.md");
    await expect(page.getByTestId("inline-interaction")).toHaveCount(0);
    await expect(page.getByTestId("plan-chip")).toBeVisible();
    await expect(page.getByTestId("composer-input")).toBeVisible();
    await expect(page.getByTestId("composer-input")).toBeEnabled();
    await page.getByTestId("dialog-hide").click();
    await expect(page.getByTestId("plan-pane")).toHaveCount(0);
    await expect(page.getByTestId("composer-input")).toBeVisible();
    await expect(page.getByTestId("composer-input")).toHaveAttribute("placeholder", "Request changes…");
    await capture(page, "chat-turn-status-inline-decisions");
  });

  test("keeps the conversation list, its row menu and the sort groups inside the shell", async ({ page }) => {
    await openWorkspace(page, {
      ...VISUAL_SEED,
      sessions: [
        { id: "session-long", title: "Investigate the authentication flow and document the regression", cwd: "/Users/demo/projects/cook-demo", updatedAt: "2026-09-17T10:00:00Z" },
        { id: "session-login", title: "Fix login bug", cwd: "/Users/demo/work/api-server", updatedAt: "2026-09-15T10:00:00Z" },
        { id: "session-providers", title: "Provider settings", cwd: "/Users/demo/projects/cook-demo", updatedAt: "2026-09-14T10:00:00Z" },
      ],
    });

    // The brand mark is drawn at twice the size the sidebar shipped with.
    expect((await page.locator(".brand-mark").boundingBox())?.width).toBe(44);
    await expect(page.locator(".session-group-heading")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await capture(page, "conversation-list-time");

    // One overflow menu per row, kept inside the window next to its trigger.
    const row = page.getByTestId("session-row-session-login");
    await row.hover();
    await row.getByTestId("session-menu-session-login").click();
    const viewport = page.viewportSize()!;
    const menu = (await page.locator(".session-menu").boundingBox())!;
    expect(menu.x).toBeGreaterThanOrEqual(0);
    expect(menu.x + menu.width).toBeLessThanOrEqual(viewport.width);
    expect(menu.y + menu.height).toBeLessThanOrEqual(viewport.height);
    await capture(page, "conversation-row-menu");

    await page.getByTestId("session-pin-session-login").click();
    await expect(page.locator(".session-group-heading span")).toHaveText(["Pinned"]);
    await page.getByTestId("conversation-sort").click();
    await page.getByTestId("sort-workspace").click();
    // The pinned block leads, then one block per workspace, most recently used first.
    await expect(page.locator(".session-group-heading span")).toHaveText(["Pinned", "cook-demo"]);
    await expectNoHorizontalOverflow(page);
    await capture(page, "conversation-list-workspace");

    await page.getByLabel("Settings").click();
    await page.getByTestId("theme-option-light").click();
    await page.keyboard.press("Escape");
    await page.getByTestId("conversation-sort").click();
    await page.getByTestId("sort-time").click();
    await row.hover();
    await row.getByTestId("session-menu-session-login").click();
    // Delete keeps the light red danger tone in the light theme too.
    await expect(page.locator(".session-menu button.session-menu-danger")).toHaveCSS("color", "rgb(205, 49, 49)");
    await capture(page, "conversation-row-menu-light");
  });

  test("keeps the live turn status, the reorder line and the width handle inside the sidebar", async ({ page }) => {
    // Hold the turn open so the working conversation keeps its status row while we measure.
    await openWorkspace(page, { ...VISUAL_SEED, promptDelayMs: 20_000 });
    await page.getByTestId("session-row-session-login").locator(".session-open").click();
    await page.getByTestId("composer-input").fill("document the regression");
    await page.getByTestId("send-button").click();
    await waitForTurnStatus(page);

    // The status replaces the date line on the working row only: same height, inside the row.
    const running = page.locator(".session-row.active");
    const status = running.getByTestId("session-turn-status");
    const rowBox = (await running.boundingBox())!;
    const statusBox = (await status.boundingBox())!;
    expect(statusBox.x).toBeGreaterThanOrEqual(rowBox.x);
    expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
    await expect(status.locator(".session-turn-spinner")).toHaveCSS("color", "rgb(0, 120, 212)");
    await expect(page.locator(".session-date")).toHaveCount(VISUAL_SEED.sessions.length - 1);
    await expectNoHorizontalOverflow(page);
    await capture(page, "conversation-turn-status");

    // A conversation the window is not showing keeps its status: the path stays on the line, the
    // status takes the date's place at the right, and its clock keeps ticking on its own.
    await page.getByTestId("session-row-session-long").locator(".session-open").click();
    await expect(page.getByTestId("session-row-session-long")).toHaveClass(/active/);
    const background = page.getByTestId("session-row-session-login");
    const backgroundStatus = background.getByTestId("session-turn-status");
    await expect(backgroundStatus).toHaveAttribute("data-live", "false");
    const pathBox = (await background.locator(".session-workspace-name").boundingBox())!;
    const carriedBox = (await backgroundStatus.boundingBox())!;
    expect(pathBox.x + pathBox.width).toBeLessThanOrEqual(carriedBox.x);
    await expect(background.locator(".session-date")).toHaveCount(0);
    const backgroundTimer = background.locator(".session-turn-timer");
    await expect(backgroundTimer).toHaveText(/^\d/);
    const firstTick = await backgroundTimer.textContent();
    await expect.poll(() => backgroundTimer.textContent()).not.toBe(firstTick);
    await expectNoHorizontalOverflow(page);
    await capture(page, "conversation-turn-status-background");

    // The narrowest sidebar still holds the path and the status on one line.
    await page.getByTestId("sidebar-resizer").focus();
    for (let step = 0; step < 20; step += 1) await page.keyboard.press("ArrowLeft");
    expect(await page.getByTestId("sidebar-resizer").getAttribute("aria-valuenow")).toBe("208");
    const narrowRow = (await background.boundingBox())!;
    const narrowStatus = (await backgroundStatus.boundingBox())!;
    expect(narrowStatus.x + narrowStatus.width).toBeLessThanOrEqual(narrowRow.x + narrowRow.width + 1);
    expect(narrowStatus.height).toBeLessThanOrEqual(14);
    await expect(background.locator(".session-workspace-name")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await capture(page, "conversation-turn-status-narrow");

    // Reopening it lands the chat's own row on that same clock and phase.
    await background.locator(".session-open").click();
    await expect(background).toHaveClass(/active/);
    await expect(page.getByTestId("turn-status")).toContainText("Responding…");
    await expect(page.getByTestId("turn-status").locator(".turn-status-timer")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // A carried row paints its drop line inside the sidebar, and the source dims.
    const source = (await page.getByTestId("session-row-session-login").boundingBox())!;
    const target = (await page.getByTestId("session-row-session-long").boundingBox())!;
    await page.mouse.move(source.x + 60, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(source.x + 60, source.y + source.height / 2 + 12, { steps: 3 });
    await page.mouse.move(source.x + 60, target.y + 4, { steps: 8 });
    await expect(page.getByTestId("session-row-session-login")).toHaveClass(/dragging/);
    const line = page.locator(".session-row.drop-before");
    await expect(line).toHaveCount(1);
    const lineBox = await line.evaluate((node) => node.getBoundingClientRect().width);
    expect(lineBox).toBeLessThanOrEqual((await page.locator(".sidebar").boundingBox())!.width);
    await capture(page, "conversation-row-dragging");
    await page.mouse.up();
    await expect(page.locator(".session-row.drop-before")).toHaveCount(0);

    // The width handle straddles the sidebar's right edge and spans its full height.
    const sidebarBefore = (await page.locator(".sidebar").boundingBox())!;
    const handle = (await page.getByTestId("sidebar-resizer").boundingBox())!;
    expect(handle.height).toBeCloseTo(sidebarBefore.height, 0);
    const edge = sidebarBefore.x + sidebarBefore.width;
    expect(handle.x + handle.width / 2).toBeGreaterThan(edge - 6);
    expect(handle.x + handle.width / 2).toBeLessThan(edge + 6);
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 120);
    await page.mouse.down();
    await page.mouse.move(handle.x + 600, handle.y + 120, { steps: 10 });
    await page.mouse.up();
    const widened = (await page.locator(".sidebar").boundingBox())!.width;
    expect(widened).toBeGreaterThan(sidebarBefore.width);
    expect(widened).toBe(440);
    expect((await page.locator(".main-column").boundingBox())!.width).toBeGreaterThan(600);
    await expectNoHorizontalOverflow(page);
    await capture(page, "conversation-sidebar-wide");

    await page.getByLabel("Settings").click();
    await page.getByTestId("theme-option-light").click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".session-row.active").getByTestId("session-turn-status")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await capture(page, "conversation-sidebar-wide-light");
  });
});
