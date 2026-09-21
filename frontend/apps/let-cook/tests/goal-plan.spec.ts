import { expect, test, type Page } from "@playwright/test";
import { CONNECTED_SEED } from "./seed";
import { MOCK_PLAN_FILE, api, openWorkspace, waitForCalls } from "./support/harness";

/**
 * Agent-driven surfaces over the recording mock ACP transport: the goal chip and plan review, and
 * the elicitation, project-instructions and skills surfaces the agent drives.
 *
 * `VITE_MOCK_ACP=1` swaps the Tauri IPC bridge for `src/acp/mock-transport.ts`; every mutation the
 * UI performs is an ACP request we can read back.
 */

test.describe("goal and plan presentation", () => {
  const composer = (page: Page) => page.getByPlaceholder("Ask Cook anything…");
  const PLAN_SEED = {
    ...CONNECTED_SEED,
    promptUpdates: [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Writing the plan." } },
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
  };

  test("paints plan entries with the todo pane's status glyphs", async ({ page }) => {
    await openWorkspace(page, PLAN_SEED);
    await composer(page).fill("show me the plan");
    await composer(page).press("Enter");

    await expect(page.getByText("Writing the plan.")).toBeVisible();
    await expect(page.locator(".plan-card")).toHaveCount(0);
    await expect(page.getByTestId("todo-overlay")).toHaveCount(0);
    await expect(page.getByTestId("todo-toggle")).toContainText("Checklist");
    await expect(page.getByTestId("todo-chip-count")).toHaveText("1/4");
    await page.getByTestId("todo-toggle").click();
    const overlay = page.getByTestId("todo-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay.getByTestId("plan-entry-completed")).toContainText("Map the TUI goal surface");
    await expect(overlay.getByTestId("plan-entry-in_progress")).toContainText("Render the goal chip");
    await expect(overlay.getByTestId("plan-entry-pending")).toContainText("Add the completion marker");
    // ACP has no cancelled status, so the cancelled row only shows through `_meta.cancelled`.
    await expect(overlay.getByTestId("plan-entry-cancelled")).toContainText("Drop the old approach");

    // ACP Plan updates replace the list in place instead of appending a second card.
    await page.evaluate(() => window.__cookMock!.sessionNotification({
      sessionUpdate: "plan",
      entries: [{ content: "Render the goal chip", priority: "high", status: "completed" }],
    }));
    await expect(overlay.getByTestId("plan-entry-completed")).toHaveCount(1);
    await expect(page.getByTestId("todo-overlay")).toHaveCount(1);
  });

  test("anchors a comment to dragged lines and sends it through the composer", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    const requestId = await page.evaluate(() => window.__cookMock!.plan());
    const first = await page.getByTestId("plan-line-3").boundingBox();
    const last = await page.getByTestId("plan-line-4").boundingBox();
    await page.mouse.move(first!.x + 60, first!.y + first!.height / 2);
    await page.mouse.down();
    await page.mouse.move(last!.x + 60, last!.y + last!.height / 2);
    await page.mouse.up();

    const input = page.getByTestId("composer-input");
    await expect(input).toHaveAttribute("placeholder", "Type your comment…");
    await expect(page.getByTestId("plan-pane")).toBeVisible();
    await input.fill("split these into two steps");
    await input.press("Enter");
    await expect(page.getByTestId("plan-comment-0")).toContainText("L3-4");
    await expect(page.getByTestId("plan-comment-badge")).toHaveText("1 ●");

    await page.getByTestId("plan-changes").click();
    await expect(input).toHaveAttribute("placeholder", "Request changes…");
    await input.press("Enter");
    await expect.poll(async () => (await mock.responses()).find((entry) => entry.id === requestId)?.result).toEqual({
      outcome: "cancelled",
      feedback: "Proposed plan lines 3-4:\n> 1. Update the transcript renderer\n> 2. Verify the desktop flow\n\nComment:\nsplit these into two steps",
    });
  });

  test("approves on empty a, but types a when the composer has text", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    const requestId = await page.evaluate(() => window.__cookMock!.plan());
    const input = page.getByTestId("composer-input");
    await input.click();
    await input.fill("keep");
    await input.press("a");
    await expect(input).toHaveValue("keepa");
    expect((await mock.responses()).find((entry) => entry.id === requestId)).toBeUndefined();
    await input.fill("");
    await input.press("a");
    await expect.poll(async () => (await mock.responses()).find((entry) => entry.id === requestId)?.result).toEqual({ outcome: "approved" });
  });

  test("queues a follow-up while a turn is running", async ({ page }) => {
    await openWorkspace(page, { ...CONNECTED_SEED, promptDelayMs: 250 });
    const input = page.getByTestId("composer-input");
    await input.fill("hello");
    await input.press("Enter");
    await expect(page.getByTestId("turn-status")).toBeVisible();
    await expect(input).toBeEnabled();
    await expect(page.getByTestId("interject-button")).toHaveCount(0);
    await input.fill("follow up");
    await input.press("Enter");
    const prompts = await waitForCalls(page, "session/prompt", 2);
    expect((prompts.at(-1)?.params.prompt as Array<Record<string, unknown>>)).toEqual([{ type: "text", text: "follow up" }]);
    await expect(page.getByTestId("send-button")).toContainText("Queue");

    // Agent queue list paints above turn-status (TUI §3 / §9.7).
    await page.evaluate(() => window.__cookMock!.queueChanged([
      { id: "q1", version: 0, text: "follow up", kind: "prompt", position: 0 },
    ]));
    const queue = page.getByTestId("queue-bar");
    await expect(queue).toBeVisible();
    await expect(queue).toContainText("follow up");
    const queueBox = await queue.boundingBox();
    const statusBox = await page.getByTestId("turn-status").boundingBox();
    expect(queueBox && statusBox && queueBox.y < statusBox.y).toBe(true);
    await expect(page.getByTestId("queue-send-now-q1")).toBeVisible();
    await expect(page.getByTestId("queue-edit-q1")).toBeVisible();
    await expect(page.getByTestId("queue-remove-q1")).toBeVisible();
  });

  test("queue pane can edit, send now, and remove held prompts", async ({ page }) => {
    await openWorkspace(page, { ...CONNECTED_SEED, promptDelayMs: 400 });
    const input = page.getByTestId("composer-input");
    await input.fill("hello");
    await input.press("Enter");
    await expect(page.getByTestId("turn-status")).toBeVisible();
    await page.evaluate(() => window.__cookMock!.queueChanged([
      { id: "q-a", version: 1, text: "first queued", kind: "prompt", position: 0 },
      { id: "q-b", version: 0, text: "second queued", kind: "prompt", position: 1 },
    ]));
    await expect(page.getByTestId("queue-bar")).toContainText("2 queued");

    await page.getByTestId("queue-edit-q-a").click();
    await expect(input).toHaveValue("first queued");
    await expect(page.getByTestId("send-button")).toContainText("Save");
    await input.fill("first queued edited");
    await input.press("Enter");
    await expect.poll(async () =>
      (await api(page).requests()).some((entry) => entry.method === "x.ai/queue/edit"),
    ).toBe(true);
    await expect(input).toHaveValue("");

    await page.getByTestId("queue-send-now-q-b").click();
    await expect.poll(async () =>
      (await api(page).requests()).filter((entry) => entry.method === "x.ai/queue/interject").length,
    ).toBeGreaterThan(0);

    await page.evaluate(() => window.__cookMock!.queueChanged([
      { id: "q-c", version: 0, text: "drop me", kind: "prompt", position: 0 },
    ]));
    await page.getByTestId("queue-remove-q-c").click();
    await expect(page.getByTestId("queue-bar")).toHaveCount(0);
  });

  test("shows an empty plan without an inline card and can quit it", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    const requestId = await page.evaluate(() => window.__cookMock!.plan({ planContent: null }));
    await expect(page.getByTestId("inline-interaction")).toHaveCount(0);
    const pane = page.getByTestId("plan-pane");
    await expect(pane).toContainText(`${MOCK_PLAN_FILE} (empty)`);
    await expect(pane).toContainText("No plan written yet");
    await page.getByTestId("plan-quit").click();
    await expect(page.getByTestId("plan-pane")).toHaveCount(0);
    expect((await mock.responses()).find((entry) => entry.id === requestId)?.result).toEqual({ outcome: "abandoned" });
  });

  test("shows the goal chip, its detail surface and the end-to-end row", async ({ page }) => {
    await openWorkspace(page, CONNECTED_SEED);
    await composer(page).fill("start the goal");
    await composer(page).press("Enter");
    // A goal belongs to a session, so wait for the prompt to create one before the shell reports.
    await expect(page.locator(".session-event")).toBeVisible();

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
      last_event: "worker_completed",
      last_event_detail: "Core logic",
      classifier_runs_attempted: 1,
      classifier_max_runs: 3,
      last_classifier_verdict: "not_achieved",
      last_classifier_details_path: "/tmp/details.md",
    })));

    await page.evaluate(() => window.__cookMock!.sessionNotification({
      sessionUpdate: "plan",
      entries: [
        { content: "Map the TUI goal surface", priority: "high", status: "completed" },
        { content: "Render the goal chip", priority: "high", status: "in_progress" },
      ],
    }));

    const chip = page.getByTestId("goal-chip");
    await expect(chip).toBeVisible();
    // The Goal detail owns the same plan checklist, so the standalone header checklist is merged.
    await expect(page.getByTestId("todo-toggle")).toHaveCount(0);
    await expect(chip).toContainText("Goal: Executing");
    await expect(chip).toContainText("/100k tokens");

    await chip.click();
    const detail = page.getByTestId("goal-detail");
    await expect(page.getByTestId("goal-detail-status")).toContainText("Active · Executing");
    await expect(detail).toContainText("Budget: 25k / 100k tokens (25%)");
    await expect(detail).toContainText(/Elapsed: 1m\d\ds/);
    // The goal's progress list is the session's plan, the same entries the todo pane holds.
    await expect(detail.getByTestId("plan-entry-in_progress")).toContainText("Render the goal chip");
    await expect(detail).toContainText("Active Subagent: worker (round 6)");
    await expect(detail).toContainText("Context: 35%");
    await expect(detail).toContainText("Last verdict: Not Achieved");
    await expect(detail).toContainText("Attempts: 1/3");
    await expect(detail).toContainText("Details: /tmp/details.md");
    await expect(detail).toContainText("Worker completed");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("goal-detail")).toHaveCount(0);

    await page.evaluate(() => window.__cookMock!.sessionNotification(window.__cookMock!.goalUpdate({ status: "complete", elapsed_ms: 619_000 })));
    await expect(chip).toContainText("Goal: Done");
    await expect(page.locator(".session-event", { hasText: "Goal complete" })).toHaveText("Goal complete in 10m19s end-to-end.");
  });

  test("labels the turn as verifying while the goal's completion is checked", async ({ page }) => {
    await openWorkspace(page, {
      ...CONNECTED_SEED,
      promptDelayMs: 1_500,
      promptUpdates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done with the work." } }],
    });
    await composer(page).fill("finish the goal");
    await page.getByTestId("send-button").click();
    // Wait for the streaming phase itself: an update sent while no turn is up leaves the row
    // hidden, which would be read as "no label" rather than "label replaced".
    await expect(page.getByTestId("turn-status")).toContainText("Responding…");

    await page.evaluate(() => window.__cookMock!.sessionNotification(window.__cookMock!.goalUpdate({
      verifying_completion: true,
      classifier_runs_attempted: 1,
      classifier_max_runs: 3,
    })));
    await expect(page.getByTestId("turn-status")).toContainText("Verifying…");
    await expect(page.getByTestId("goal-chip")).toContainText("Goal: Verifying (1/3)");
  });

  test("shows a paused goal's resume hint and drops it once cleared", async ({ page }) => {
    await openWorkspace(page, CONNECTED_SEED);
    await page.evaluate(() => window.__cookMock!.sessionNotification(window.__cookMock!.goalUpdate({
      status: "user_paused",
      pause_message: "user",
      elapsed_ms: 30_000,
    })));
    const chip = page.getByTestId("goal-chip");
    await expect(chip).toContainText("Goal: Paused");
    await chip.click();
    await expect(page.getByTestId("goal-detail")).toContainText("Status: Paused. Type /goal resume to continue");
    await page.keyboard.press("Escape");

    await page.evaluate(() => window.__cookMock!.sessionNotification(window.__cookMock!.goalUpdate({ status: "cleared", goal_id: "" })));
    await expect(chip).toHaveCount(0);
  });
});

test.describe("agent-driven surfaces", () => {
  test("answers an MCP elicitation in the interaction modal", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    const requestId = await mock.elicit();
    await expect(page.getByTestId("elicit-fields")).toBeVisible();
    await expect(page.getByTestId("elicit-accept")).toBeDisabled();
    await page.getByTestId("elicit-path").fill("/home/demo/projects");
    await page.getByTestId("elicit-depth").fill("2");
    await page.getByTestId("elicit-accept").click();
    await expect(page.getByTestId("elicit-fields")).toHaveCount(0);
    const answer = (await mock.responses()).find((entry) => entry.id === requestId);
    expect(answer?.result).toEqual({ outcome: "accept", content: { path: "/home/demo/projects", depth: 2 } });
  });

  test("edits project instructions through the agent's fs extensions", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Memory & project" }).click();
    await page.getByTestId("project-instructions").fill("# Rules\n\nBe brief.\n");
    await page.getByTestId("project-save").click();
    await expect(page.getByTestId("project-status")).toContainText("Saved");
    const writes = await waitForCalls(page, "x.ai/fs/write_file");
    expect(writes[0].params.path).toContain("AGENTS.md");
    expect(writes[0].params.content).toContain("Be brief.");
    const files = (await mock.state()).files as Record<string, string>;
    expect(Object.values(files).some((content) => content.includes("Be brief."))).toBe(true);
  });

  test("lists and toggles skills by topic, and browses memory", async ({ page }) => {
    const mock = api(page);
    await openWorkspace(page, CONNECTED_SEED);
    await page.getByRole("button", { name: "New chat" }).click();
    await waitForCalls(page, "session/new");
    await page.getByLabel("Settings").click();
    await page.getByRole("tab", { name: "Skills" }).click();
    // Topic groups for bundled skills; User still wraps user-scoped rows.
    await expect(page.getByTestId("skill-group-Game")).toContainText("Game (2)");
    await expect(page.getByTestId("skill-group-Documents")).toContainText("Documents (1)");
    await expect(page.getByTestId("skill-group-User")).toContainText("User (1)");
    await expect(page.getByTestId("skill-game-tilesets")).toContainText("Game tilesets");
    await expect(page.getByTestId("plugin-cook-core")).toContainText("1.0.0");
    await page.getByLabel("Toggle skill game-tilesets").click();
    const skillToggles = await waitForCalls(page, "x.ai/skills/toggle");
    // `SkillsListRequest.cwd` is a required field on the shell side, so it must always travel.
    expect(skillToggles[0].params).toMatchObject({ name: "game-tilesets", enabled: false, cwd: "/tmp/cook-demo" });
    expect(skillToggles[0].params).not.toHaveProperty("names");

    // Game is fully off; its switch enables every disabled member via sequential { name } calls.
    await expect(page.getByLabel("Toggle all Game")).toHaveAttribute("aria-checked", "false");
    await page.getByLabel("Toggle all Game").click();
    const reenabled = await waitForCalls(page, "x.ai/skills/toggle", 3);
    // Rows are label-sorted inside the group, so asset-core precedes tilesets.
    expect(reenabled[1].params).toMatchObject({ name: "game-asset-core", enabled: true, cwd: "/tmp/cook-demo" });
    expect(reenabled[1].params).not.toHaveProperty("names");
    expect(reenabled[2].params).toMatchObject({ name: "game-tilesets", enabled: true, cwd: "/tmp/cook-demo" });
    expect(reenabled[2].params).not.toHaveProperty("names");

    // Uniform again, so the same switch turns the whole category off with one call per name.
    await expect(page.getByLabel("Toggle all Game")).toHaveAttribute("aria-checked", "true");
    await page.getByLabel("Toggle all Game").click();
    const categoryOff = await waitForCalls(page, "x.ai/skills/toggle", 5);
    expect(categoryOff[3].params).toMatchObject({ name: "game-asset-core", enabled: false, cwd: "/tmp/cook-demo" });
    expect(categoryOff[4].params).toMatchObject({ name: "game-tilesets", enabled: false, cwd: "/tmp/cook-demo" });
    expect(categoryOff.every((entry) => !("names" in entry.params))).toBe(true);

    // The category header folds its rows without touching skill state.
    await expect(page.getByTestId("skill-group-Game").getByRole("button", { name: "Game (2)" })).toHaveAttribute("aria-expanded", "true");
    await page.getByTestId("skill-group-Game").getByRole("button", { name: "Game (2)" }).click();
    await expect(page.getByTestId("skill-game-tilesets")).toHaveCount(0);
    await page.getByTestId("skill-group-Game").getByRole("button", { name: "Game (2)" }).click();
    await expect(page.getByTestId("skill-game-tilesets")).toBeVisible();

    // Turn the category back on so the rest of this test starts from a known state.
    await page.getByLabel("Toggle all Game").click();
    await waitForCalls(page, "x.ai/skills/toggle", 7);

    const skillDescription = page.getByTestId("skill-game-tilesets").locator(".skill-description");
    await expect(skillDescription).toHaveAttribute("aria-expanded", "false");
    await skillDescription.click();
    await expect(skillDescription).toHaveAttribute("aria-expanded", "true");
    // The search box filters without dropping the topic groups that still match.
    await page.getByTestId("skill-search").fill("review");
    await expect(page.getByTestId("skill-game-tilesets")).toHaveCount(0);
    await expect(page.getByTestId("skill-review")).toBeVisible();
    await expect(page.getByTestId("skill-group-Game")).toHaveCount(0);
    await page.getByTestId("skill-search").fill("");
    await expect(page.getByTestId("skill-game-tilesets")).toBeVisible();
    await expect(page.getByTestId("plugins-reload")).toBeVisible();
    await expect(page.getByTestId("workflow-list")).toBeVisible();

    await page.getByRole("tab", { name: "Hooks" }).click();
    await expect(page.getByTestId("hooks-panel")).toBeVisible();
    await page.getByTestId("hooks-trust").click();
    await waitForCalls(page, "x.ai/hooks/action");

    await page.getByRole("tab", { name: "Memory & project" }).click();
    await page.getByTestId("memory-flush").click();
    await expect(page.getByTestId("memory-status")).toContainText("flush requested");
    await expect(page.getByTestId("memory-browser")).toBeVisible();
  });
});
