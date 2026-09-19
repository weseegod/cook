import { expect, test, type Page } from "@playwright/test";
import { CONNECTED_SEED } from "./seed";
import { api, callsTo, openWorkspace, waitForCalls } from "./support/harness";

/**
 * The conversation list (sidebar sessions) over the recording mock ACP transport, including the
 * per-session fork action the sidebar row menu drives.
 *
 * `VITE_MOCK_ACP=1` swaps the Tauri IPC bridge for `src/acp/mock-transport.ts`; every mutation the
 * UI performs is an ACP request we can read back.
 */

test.describe("conversation list", () => {
  /** Three conversations across two workspaces, newest first: alpha-new, beta, alpha-old. */
  const LIST_SEED = {
    ...CONNECTED_SEED,
    sessions: [
      { id: "s-alpha-new", title: "Alpha newest", cwd: "/Users/demo/projects/cook-demo", updatedAt: "2026-09-18T10:00:00Z" },
      { id: "s-beta", title: "Beta task", cwd: "/Users/demo/work/api-server", updatedAt: "2026-09-17T10:00:00Z" },
      { id: "s-alpha-old", title: "Alpha oldest", cwd: "/Users/demo/projects/cook-demo", updatedAt: "2026-09-10T10:00:00Z" },
    ],
  };

  function rowTitles(page: Page) {
    return page.locator(".session-row .session-open strong").allTextContents();
  }

  async function openRowMenu(page: Page, id: string) {
    const row = page.getByTestId(`session-row-${id}`);
    await row.hover();
    await row.getByTestId(`session-menu-${id}`).click();
    await expect(row.getByRole("menu")).toBeVisible();
    return row;
  }

  /**
   * Press a row's title, carry it to another row's upper or lower half, release. Returns the source
   * and target class attributes sampled while the row was still carried, so callers can assert the
   * in-flight affordances. Reordering runs on pointer events (the desktop shell swallows HTML5
   * drags for its file-drop handler), so this drives the mouse rather than `dragTo`.
   */
  async function dragRow(page: Page, fromId: string, toId: string, position: "before" | "after" = "after") {
    const source = (await page.getByTestId(`session-row-${fromId}`).boundingBox())!;
    const target = (await page.getByTestId(`session-row-${toId}`).boundingBox())!;
    const x = source.x + Math.min(60, source.width / 2);
    const y = source.y + source.height / 2;
    const dropY = position === "before" ? target.y + 4 : target.y + target.height - 4;
    await page.mouse.move(x, y);
    await page.mouse.down();
    // Clear the 4px threshold first, so the press reads as a reorder rather than a click.
    await page.mouse.move(x, y + 12, { steps: 3 });
    await page.mouse.move(x, dropY, { steps: 8 });
    const midDrag = {
      source: (await page.getByTestId(`session-row-${fromId}`).getAttribute("class")) ?? "",
      target: (await page.getByTestId(`session-row-${toId}`).getAttribute("class")) ?? "",
    };
    await page.mouse.up();
    return midDrag;
  }

  test("folds the row actions into one menu and pins a conversation across reloads", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openWorkspace(page, LIST_SEED);

    // The four hover icons are gone; each row carries one overflow trigger instead.
    await expect(page.getByTestId("session-fork-s-alpha-old")).toHaveCount(0);
    await expect(page.locator(".session-menu-trigger")).toHaveCount(3);

    const row = await openRowMenu(page, "s-alpha-old");
    const menu = row.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveText(["Pin to top", "Rename", "Fork", "Export", "Delete"]);

    // Delete reads as the light red danger tone; the other actions stay grey.
    const [danger, plain] = await Promise.all([
      menu.getByTestId("session-delete-s-alpha-old").evaluate((node) => getComputedStyle(node).color),
      menu.getByTestId("session-rename-s-alpha-old").evaluate((node) => getComputedStyle(node).color),
    ]);
    expect(danger).toBe("rgb(244, 135, 113)");
    expect(plain).not.toBe(danger);

    await menu.getByTestId("session-pin-s-alpha-old").click();
    await expect(row).toHaveAttribute("data-pinned", "true");
    await expect(page.locator(".session-group-heading span")).toHaveText(["Pinned"]);
    expect(await rowTitles(page)).toEqual(["Alpha oldest", "Alpha newest", "Beta task"]);

    await page.reload();
    await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
    await expect(page.getByTestId("session-row-s-alpha-old")).toHaveAttribute("data-pinned", "true");
    expect(await rowTitles(page)).toEqual(["Alpha oldest", "Alpha newest", "Beta task"]);

    // The same menu unpins, and the pinned block disappears with it.
    const reopened = await openRowMenu(page, "s-alpha-old");
    await reopened.getByTestId("session-pin-s-alpha-old").click();
    await expect(page.getByTestId("session-row-s-alpha-old")).toHaveAttribute("data-pinned", "false");
    await expect(page.locator(".session-group-heading")).toHaveCount(0);
    expect(await rowTitles(page)).toEqual(["Alpha newest", "Beta task", "Alpha oldest"]);
    expect(errors).toEqual([]);
  });

  test("reorders conversations by dragging a row", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openWorkspace(page, LIST_SEED);
    expect(await rowTitles(page)).toEqual(["Alpha newest", "Beta task", "Alpha oldest"]);

    // While a row is carried over another one, both paint their affordance: the source dims and
    // the target shows which half the drop will land on.
    const carried = await dragRow(page, "s-alpha-old", "s-alpha-new", "before");
    expect(carried.source).toContain("dragging");
    expect(carried.target).toContain("drop-before");
    expect(await rowTitles(page)).toEqual(["Alpha oldest", "Alpha newest", "Beta task"]);
    await expect(page.getByTestId("session-row-s-alpha-new")).not.toHaveClass(/drop-before/);
    // Releasing after a reorder must not also open the conversation that was carried.
    expect(await callsTo(await api(page).requests(), "session/load")).toHaveLength(0);

    // The arrangement survives a reload, and the sort menu offers a way back to plain recency.
    await page.reload();
    await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
    expect(await rowTitles(page)).toEqual(["Alpha oldest", "Alpha newest", "Beta task"]);

    await page.getByTestId("conversation-sort").click();
    await page.getByTestId("sort-reset-order").click();
    expect(await rowTitles(page)).toEqual(["Alpha newest", "Beta task", "Alpha oldest"]);

    // A plain click still opens a conversation, and the press that carried a row is not one.
    await page.getByTestId("session-row-s-beta").locator(".session-open").click();
    await waitForCalls(page, "session/load");
    await expect(page.getByTestId("session-row-s-beta")).toHaveClass(/active/);
    expect(await rowTitles(page)).toEqual(["Alpha newest", "Beta task", "Alpha oldest"]);
    expect(errors).toEqual([]);
  });

  test("shows the running turn on the conversation the agent is working in", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Hold the prompt response open so the turn stays live long enough to inspect.
    await openWorkspace(page, { ...LIST_SEED, promptDelayMs: 3000 });

    // Idle rows carry workspace and date, and no row shows a status yet.
    await expect(page.getByTestId("session-turn-status")).toHaveCount(0);
    await expect(page.getByTestId("session-row-s-beta").locator(".session-date")).toBeVisible();

    await page.getByTestId("session-row-s-alpha-new").locator(".session-open").click();
    await waitForCalls(page, "session/load");
    await page.getByPlaceholder("Ask Cook anything…").fill("summarise the repo");
    await page.getByTestId("send-button").click();
    await waitForCalls(page, "session/prompt");

    const status = page.getByTestId("session-row-s-alpha-new").getByTestId("session-turn-status");
    await expect(status).toBeVisible();
    await expect(status).toContainText("Responding");
    await expect(status).toHaveAttribute("data-live", "true");
    await expect(status.locator(".session-turn-timer")).toHaveText(/\d/);
    // The workspace path stays on the line; the status sits to its right in place of the date.
    const working = page.getByTestId("session-row-s-alpha-new");
    await expect(working.locator(".session-workspace-name")).toHaveText("cook-demo");
    await expect(working.locator(".session-date")).toHaveCount(0);
    expect((await status.boundingBox())!.x).toBeGreaterThan((await working.locator(".session-path").boundingBox())!.x);
    // Only the working conversation is annotated: the rest keep their metadata line.
    await expect(page.getByTestId("session-turn-status")).toHaveCount(1);
    await expect(page.getByTestId("session-row-s-beta").locator(".session-date")).toBeVisible();

    // The status clears once the turn ends.
    await expect(page.getByTestId("session-row-s-alpha-new").getByTestId("session-turn-status")).toHaveCount(0);
    await expect(page.getByTestId("session-row-s-alpha-new").locator(".session-date")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("shows the turn for a new chat the agent has not listed yet", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openWorkspace(page, { ...LIST_SEED, promptDelayMs: 3000 });
    expect(await rowTitles(page)).toEqual(["Alpha newest", "Beta task", "Alpha oldest"]);

    // `session/new` reports an id the seeded list does not know, so the row is the window's own.
    await page.getByRole("button", { name: "New chat" }).click();
    const open = page.locator(".session-row.active");
    await expect(open).toHaveCount(1);
    await expect(open.locator(".session-open strong")).toHaveText("Untitled conversation");
    await expect(open.locator(".session-workspace-name")).toBeVisible();
    await expect(page.getByTestId("session-turn-status")).toHaveCount(0);

    await page.getByPlaceholder("Ask Cook anything…").fill("start from scratch");
    await page.getByTestId("send-button").click();
    await waitForCalls(page, "session/prompt");

    // The working conversation reports from the list without having been picked out of it.
    await expect(open.getByTestId("session-turn-status")).toHaveAttribute("data-live", "true");
    await expect(open.getByTestId("session-turn-status")).toContainText("Responding");
    expect(await rowTitles(page)).toHaveLength(4);
    // The conversation list keeps the conversations the agent does report.
    for (const id of ["s-alpha-new", "s-beta", "s-alpha-old"]) {
      await expect(page.getByTestId(`session-row-${id}`)).toBeVisible();
    }
    expect(errors).toEqual([]);
  });

  test("keeps the turn visible in the list after opening another conversation", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openWorkspace(page, { ...LIST_SEED, promptDelayMs: 3000 });

    await page.getByTestId("session-row-s-alpha-new").locator(".session-open").click();
    await waitForCalls(page, "session/load");
    await page.getByPlaceholder("Ask Cook anything…").fill("hold this turn open");
    await page.getByTestId("send-button").click();
    await waitForCalls(page, "session/prompt");
    const working = page.getByTestId("session-row-s-alpha-new").getByTestId("session-turn-status");
    await expect(working).toHaveAttribute("data-live", "true");

    // Opening another conversation must not drop the row that is still working, and the row keeps
    // the phase that conversation last reported instead of flattening to a generic wait.
    await page.getByTestId("session-row-s-beta").locator(".session-open").click();
    await waitForCalls(page, "session/load", 2);
    await expect(page.getByTestId("session-row-s-beta")).toHaveClass(/active/);
    await expect(working).toHaveAttribute("data-live", "false");
    await expect(working).toContainText("Responding…");
    await expect(page.getByTestId("session-row-s-alpha-new").locator(".session-workspace-name")).toHaveText("cook-demo");
    await expect(page.getByTestId("session-row-s-beta").getByTestId("session-turn-status")).toHaveCount(0);
    await expect(page.getByTestId("session-row-s-beta").locator(".session-date")).toBeVisible();

    // Switching back keeps the turn state, and the turn still ends on its own.
    await page.getByTestId("session-row-s-alpha-new").locator(".session-open").click();
    await waitForCalls(page, "session/load", 3);
    await expect(working).toHaveAttribute("data-live", "true");
    await expect(page.getByTestId("session-row-s-alpha-new").getByTestId("session-turn-status")).toHaveCount(0);
    await expect(page.getByTestId("session-row-s-alpha-new").locator(".session-date")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("marks the conversation as blocked while the agent waits for an answer", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openWorkspace(page, { ...LIST_SEED, promptDelayMs: 10_000 });

    await page.getByTestId("session-row-s-alpha-new").locator(".session-open").click();
    await waitForCalls(page, "session/load");
    await page.getByPlaceholder("Ask Cook anything…").fill("ship the sidebar");
    await page.getByTestId("send-button").click();
    await waitForCalls(page, "session/prompt");

    const status = page.getByTestId("session-row-s-alpha-new").getByTestId("session-turn-status");
    await expect(status.locator(".session-turn-spinner")).not.toHaveClass(/blocked/);

    // An open ask card is the agent waiting on the user, which the TUI paints as a diamond.
    await page.evaluate(() => void window.__cookMock!.question());
    await expect(status.locator(".session-turn-spinner")).toHaveText("◆");
    await expect(status.locator(".session-turn-spinner")).toHaveClass(/blocked/);
    await expect(status).toContainText("Waiting on answers for");
    // The chat's own activity row reports the same phase.
    await expect(page.getByTestId("turn-status").locator(".turn-status-spinner")).toHaveText("◆");
    expect(errors).toEqual([]);
  });

  test("keeps the composer usable after opening another conversation mid-turn", async ({ page }) => {
    const mock = api(page);
    // Long enough that the first turn is certainly still in flight when the second one is sent.
    await openWorkspace(page, { ...LIST_SEED, promptDelayMs: 20_000 });

    await page.getByTestId("session-row-s-alpha-new").locator(".session-open").click();
    await waitForCalls(page, "session/load");
    await page.getByPlaceholder("Ask Cook anything…").fill("hold this turn open");
    await page.getByTestId("send-button").click();
    await waitForCalls(page, "session/prompt");

    // The turn in the first conversation must not block the second one: the outstanding prompt
    // belongs to a conversation the composer is no longer showing.
    await page.getByTestId("session-row-s-beta").locator(".session-open").click();
    await waitForCalls(page, "session/load", 2);
    await page.getByPlaceholder("Ask Cook anything…").fill("work in parallel");
    await expect(page.getByTestId("send-button")).toBeEnabled();
    await page.getByTestId("send-button").click();
    await expect
      .poll(async () => callsTo(await mock.requests(), "session/prompt").length)
      .toBeGreaterThanOrEqual(2);
    const prompts = callsTo(await mock.requests(), "session/prompt");
    expect(prompts.at(-1)?.params.sessionId).toBe("s-beta");

    // Both conversations report their turn in the list.
    await expect(page.getByTestId("session-row-s-alpha-new").getByTestId("session-turn-status")).toBeVisible();
    await expect(page.getByTestId("session-row-s-beta").getByTestId("session-turn-status")).toBeVisible();
  });

  test("keeps a background conversation's phase moving as its updates arrive", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openWorkspace(page, { ...LIST_SEED, promptDelayMs: 20_000 });

    await page.getByTestId("session-row-s-alpha-new").locator(".session-open").click();
    await waitForCalls(page, "session/load");
    await page.getByPlaceholder("Ask Cook anything…").fill("hold this turn open");
    await page.getByTestId("send-button").click();
    await waitForCalls(page, "session/prompt");

    const working = page.getByTestId("session-row-s-alpha-new").getByTestId("session-turn-status");
    await expect(working).toContainText("Responding…");

    await page.getByTestId("session-row-s-beta").locator(".session-open").click();
    await waitForCalls(page, "session/load", 2);
    await expect(working).toHaveAttribute("data-live", "false");
    await expect(working).toContainText("Responding…");

    // The agent keeps streaming for the conversation that is no longer on screen; those updates
    // still move its row, so the list never reports a phase the turn has already left.
    await page.evaluate(() => window.__cookMock!.sessionNotification({
      sessionUpdate: "tool_call",
      toolCallId: "tc-bg",
      title: "execute",
      status: "pending",
      rawInput: { command: "pnpm build" },
    }, "s-alpha-new"));
    await expect(working).toContainText("Run pnpm build");
    await expect(working).toHaveAttribute("data-live", "false");
    expect(errors).toEqual([]);
  });
  test("resizes the sidebar by dragging the edge and remembers the width", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openWorkspace(page, LIST_SEED);
    const sidebar = page.locator(".sidebar");
    const startWidth = Math.round((await sidebar.boundingBox())!.width);

    const handle = (await page.getByTestId("sidebar-resizer").boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 120);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 120, handle.y + 120, { steps: 10 });
    await page.mouse.up();

    const widened = Math.round((await sidebar.boundingBox())!.width);
    expect(widened).toBeGreaterThan(startWidth + 100);
    expect((await page.getByTestId("sidebar-resizer").getAttribute("aria-valuenow"))).toBe(String(widened));
    // Nothing overflows the window, and the conversation rows keep their metadata line.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("session-row-s-beta").locator(".session-date")).toBeVisible();

    // The width is remembered across a reload.
    await page.reload();
    await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
    expect(Math.round((await sidebar.boundingBox())!.width)).toBe(widened);

    // Dragging far past the maximum clamps instead of squeezing the chat away.
    const far = (await page.getByTestId("sidebar-resizer").boundingBox())!;
    await page.mouse.move(far.x + far.width / 2, far.y + 120);
    await page.mouse.down();
    await page.mouse.move(far.x + 2000, far.y + 120, { steps: 10 });
    await page.mouse.up();
    expect(Math.round((await sidebar.boundingBox())!.width)).toBe(440);

    // Arrow keys step the width, and a double click returns to the stylesheet default.
    await page.getByTestId("sidebar-resizer").focus();
    await page.keyboard.press("ArrowLeft");
    expect(Math.round((await sidebar.boundingBox())!.width)).toBe(440 - 16);
    await page.getByTestId("sidebar-resizer").dblclick();
    expect(Math.round((await sidebar.boundingBox())!.width)).toBe(startWidth);
    await page.reload();
    await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
    expect(Math.round((await sidebar.boundingBox())!.width)).toBe(startWidth);
    expect(errors).toEqual([]);
  });

});

test.describe("session fork and export", () => {
  test("forks a sidebar session with camelCase params then loads the child", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openWorkspace(page, CONNECTED_SEED);

    const row = page.locator(".session-row", { hasText: "Fix login bug" });
    await row.hover();
    await row.getByTestId("session-menu-session-login").click();
    await row.getByTestId("session-fork-session-login").click();

    const forks = await waitForCalls(page, "x.ai/session/fork");
    expect(forks.at(-1)?.params).toMatchObject({
      sourceSessionId: "session-login",
      sourceCwd: "/tmp/cook-demo",
      newCwd: "/tmp/cook-demo",
      sessionKind: "fork",
    });
    expect(forks.at(-1)?.params).not.toHaveProperty("sessionId");

    const loaded = await waitForCalls(page, "session/load");
    expect(loaded.some((entry) => entry.params.sessionId === "fork-session-login")).toBe(true);
    await expect(page.locator(".session-row.active", { hasText: "Fix login bug (fork)" })).toBeVisible();
    expect(errors).toEqual([]);
  });

});

