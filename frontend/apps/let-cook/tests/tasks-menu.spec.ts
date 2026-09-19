import { expect, test, type Page } from "@playwright/test";
import { CONNECTED_SEED, seedAgent } from "./seed";

/**
 * The TUI's tasks surface on the desktop: a `Tasks` chip beside the header's `Plans` chip, and a
 * list that drops open under it like the plans list and closes again (`views/tasks_pane.rs`,
 * `agent_status.rs::task_status_line`, `ActionId::ToggleTasks` → Ctrl-G).
 */

async function openWorkspace(page: Page, overrides: Record<string, unknown> = {}) {
  await seedAgent(page, { ...CONNECTED_SEED, ...overrides });
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.waitForFunction(() => Boolean(window.__cookMock));
  await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
  // A task belongs to a conversation: open one and wait until the window holds its id, because a
  // row pushed before `session/new` lands belongs to no conversation yet.
  const commandsBefore = await commandLists(page);
  await page.getByRole("button", { name: "New chat" }).click();
  await expect.poll(() => commandLists(page)).toBeGreaterThan(commandsBefore);
  await expect(page.getByTestId("composer-input")).toBeVisible();
}

/** `refreshCommands` runs right after `session/new` is applied, so this counts applied sessions. */
function commandLists(page: Page): Promise<number> {
  return page.evaluate(() => window.__cookMock!.requests().filter((entry) => entry.method === "x.ai/commands/list").length);
}

function background(page: Page, overrides: Record<string, unknown>) {
  return page.evaluate((value) => window.__cookMock!.taskBackgrounded(value), overrides);
}

function complete(page: Page, taskId: string) {
  return page.evaluate(
    (id) => window.__cookMock!.taskCompleted({ task_snapshot: { task_id: id, exit_code: 0 } }),
    taskId,
  );
}

test.describe("tasks list", () => {
  test("drops open under the header chip and leaves the transcript where it was", async ({ page }) => {
    await openWorkspace(page);
    // Nothing has run in this conversation yet, so no chip at all.
    await expect(page.getByTestId("tasks-chip")).toHaveCount(0);

    await background(page, { task_id: "bg-1", description: "Wait for server", command: "sleep 30" });
    const chip = page.getByTestId("tasks-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(/Tasks/);
    // The TUI's running marker (`agent_status.rs::task_status_line`).
    await expect(page.getByTestId("tasks-chip-count")).toHaveText("1");
    // Chip, no chevron, no ✕: the only close control in the row is the ✕ per task.
    await expect(chip).toHaveText(/^Tasks\s*1$/);

    // A popover, not a strip: the transcript keeps its place while the list is over it.
    const transcriptBefore = (await page.locator(".transcript").boundingBox())!;
    await chip.click();
    const menu = page.getByTestId("tasks-menu");
    await expect(menu).toBeVisible();
    const row = page.getByTestId("task-row-bg-1");
    await expect(row).toContainText("Wait for server");
    await expect(row).toHaveAttribute("data-status", "running");
    await expect(row.locator(".activity-status")).toBeHidden();
    // The list is rows only, like the plans list: no summary line, no close button of its own.
    await expect(page.locator(".tasks-menu .activity-list")).toBeVisible();
    // The row's ✕ is the list's only button; each task closes through its own.
    await expect(page.locator(".tasks-menu button")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Close Wait for server" })).toBeVisible();
    const transcriptAfter = (await page.locator(".transcript").boundingBox())!;
    expect(transcriptAfter.y).toBe(transcriptBefore.y);
    expect(transcriptAfter.height).toBe(transcriptBefore.height);

    // It drops below the chip, starts at the chip's left edge, and extends symmetrically around
    // the chat centre.
    const [chipBox, menuBox, chatBox] = await Promise.all([
      chip.boundingBox(),
      menu.boundingBox(),
      page.locator(".chat-layout").boundingBox(),
    ]);
    expect(menuBox!.y).toBeGreaterThanOrEqual(chipBox!.y + chipBox!.height - 1);
    expect(Math.abs(menuBox!.x - chipBox!.x)).toBeLessThanOrEqual(2);
    expect(Math.abs((menuBox!.x + menuBox!.width / 2) - (chatBox!.x + chatBox!.width / 2))).toBeLessThanOrEqual(2);
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);

    // How long that task has been running, the same clock the TUI pane prints per row — and it
    // keeps counting while the row is on screen.
    const elapsed = row.locator(".activity-elapsed");
    await expect(elapsed).toHaveText(/^(\d+(\.\d+)?s|m\d+s)$/);
    const first = await elapsed.textContent();
    await expect.poll(() => elapsed.textContent(), { timeout: 4000 }).not.toBe(first);
  });

  test("scrolls a long list instead of cutting it off", async ({ page }) => {
    await openWorkspace(page);
    const count = 9;
    for (let index = 1; index <= count; index += 1) {
      await background(page, { task_id: `bg-${index}`, description: `Job ${index}`, command: `sleep ${index}` });
    }
    await page.getByTestId("tasks-chip").click();
    await expect(page.getByTestId("tasks-menu")).toBeVisible();
    await expect(page.getByTestId(`task-row-bg-${count}`)).toHaveCount(1);

    const list = page.locator(".tasks-menu .activity-list");
    expect(await list.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(0);
    // Every row stays reachable, and the popover stops at the plans list's own height cap.
    const menu = (await page.getByTestId("tasks-menu").boundingBox())!;
    expect(menu.height).toBeLessThanOrEqual(321);
    expect(menu.y + menu.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    const last = page.getByTestId(`task-row-bg-${count}`);
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeVisible();
    const lastBox = (await last.boundingBox())!;
    expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(menu.y + menu.height + 1);
  });

  test("drops a finished task off the list for good", async ({ page }) => {
    await openWorkspace(page);
    await background(page, { task_id: "bg-1", description: "Wait for server", command: "sleep 30" });
    await page.getByTestId("tasks-chip").click();
    await expect(page.getByTestId("task-row-bg-1")).toHaveAttribute("data-status", "running");

    await complete(page, "bg-1");
    // Only running work is listed, so the row leaves the list and the count follows it down.
    await expect(page.getByTestId("task-row-bg-1")).toHaveCount(0);
    await expect(page.getByText("No running tasks.")).toBeVisible();
    await expect(page.getByTestId("tasks-chip-count")).toHaveText("0");
    // Nothing on the surface brings it back.
    await expect(page.getByTestId("task-row-bg-1")).toHaveCount(0);
  });

  test("keeps the empty list compact like the Plans menu", async ({ page }) => {
    await openWorkspace(page);
    await background(page, { task_id: "bg-1", description: "Wait for server", command: "sleep 30" });
    await page.getByTestId("tasks-chip").click();
    await complete(page, "bg-1");
    await expect(page.getByText("No running tasks.")).toBeVisible();

    const tasksMenu = (await page.getByTestId("tasks-menu").boundingBox())!;
    await page.getByTestId("plan-chip").click();
    const plansMenu = (await page.getByTestId("plan-menu").boundingBox())!;
    expect(Math.abs(tasksMenu.height - plansMenu.height)).toBeLessThanOrEqual(2);
  });

  test("stops a live task through x.ai/task/kill", async ({ page }) => {
    await openWorkspace(page);
    await background(page, { task_id: "bg-2", description: "Long sleep", command: "sleep 90" });
    await page.getByTestId("tasks-chip").click();
    await page.getByTestId("task-kill-bg-2").click();

    await expect.poll(async () => {
      const requests = await page.evaluate(() => window.__cookMock!.requests());
      return requests.some((entry) => entry.method === "x.ai/task/kill" && entry.params.taskId === "bg-2");
    }).toBe(true);
    // Stopping settles the row, so it leaves the list.
    await expect(page.getByTestId("task-row-bg-2")).toHaveCount(0);
    await expect(page.getByTestId("tasks-chip-count")).toHaveText("0");
  });

  test("lists a spawned subagent beside background commands", async ({ page }) => {
    await openWorkspace(page);
    await background(page, { task_id: "bg-1", description: "Wait for server", command: "sleep 30" });
    await page.evaluate(() => window.__cookMock!.sessionNotification({
      sessionUpdate: "subagent_spawned",
      subagent_id: "sa-1",
      description: "Explore the repository",
      subagent_type: "explore",
    }));
    await page.getByTestId("tasks-chip").click();
    const row = page.getByTestId("task-row-sa-1");
    await expect(row).toContainText("Explore the repository");
    await expect(row.locator(".activity-kind")).toHaveText("Agent");
    await expect(page.getByTestId("tasks-chip-count")).toHaveText("2");
    // Two kinds on screen: the pane's sections appear (`views/tasks_pane.rs`).
    await expect(page.getByTestId("task-group-subagents")).toHaveText(/Subagents/);
    await expect(page.getByTestId("task-group-tasks")).toHaveText(/Tasks/);
  });

  test("closes from the chip, Ctrl-G, Escape and an outside click", async ({ page }) => {
    await openWorkspace(page);
    await background(page, { task_id: "bg-1", description: "Wait for server", command: "sleep 30" });
    const chip = page.getByTestId("tasks-chip");
    const menu = page.getByTestId("tasks-menu");

    await chip.click();
    await expect(menu).toBeVisible();
    await chip.click();
    await expect(menu).toHaveCount(0);

    await page.keyboard.press("Control+g");
    await expect(menu).toBeVisible();
    await chip.click();
    await expect(menu).toHaveCount(0);

    await page.keyboard.press("Control+g");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    await page.keyboard.press("Control+g");
    await expect(menu).toBeVisible();
    // Clicking away from the chip closes it, the way the plans list behaves.
    await page.getByTestId("composer-input").click();
    await expect(menu).toHaveCount(0);
  });

  test("shares its rows with the Activity tab without duplicate ids", async ({ page }) => {
    await openWorkspace(page);
    await background(page, { task_id: "bg-1", description: "Wait for server", command: "sleep 30" });

    await page.getByLabel("Open tools panel").click();
    await page.getByTestId("utility-panel").getByRole("button", { name: /^Activity/ }).click();
    await expect(page.getByTestId("activity-row-bg-1")).toBeVisible();

    await page.getByTestId("tasks-chip").click();
    await expect(page.getByTestId("tasks-menu")).toBeVisible();
    await expect(page.getByTestId("task-row-bg-1")).toBeVisible();
    await expect(page.getByTestId("activity-row-bg-1")).toBeVisible();
  });

  test("fits a narrow window and survives a light theme", async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await page.addInitScript(() => localStorage.setItem("cook.theme", "light"));
    await openWorkspace(page);
    await background(page, { task_id: "bg-1", description: "Wait for server", command: "sleep 30" });

    const chip = page.getByTestId("tasks-chip");
    await expect(chip).toBeVisible();
    await expect(page.getByTestId("plan-chip")).toBeVisible();
    await expect(page.getByTestId("plan-chip-count")).toBeVisible();
    const plan = (await page.getByTestId("plan-chip").boundingBox())!;
    const box = (await chip.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(plan.x);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");

    // The frame keeps its own minimum width below the layout breakpoint, so the popover only has
    // to avoid adding overflow of its own.
    const before = await page.evaluate(() => document.documentElement.scrollWidth);
    await chip.click();
    await expect(page.getByTestId("task-row-bg-1")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(before);

    const menu = (await page.getByTestId("tasks-menu").boundingBox())!;
    expect(menu.x).toBeGreaterThanOrEqual(0);
    expect(menu.x + menu.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    // The row did not run off the right edge of the popover.
    const kill = (await page.getByTestId("task-kill-bg-1").boundingBox())!;
    expect(kill.x + kill.width).toBeLessThanOrEqual(menu.x + menu.width + 1);
  });
});
