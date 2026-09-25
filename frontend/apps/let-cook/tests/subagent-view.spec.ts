import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, openConversation, shellSeed } from "./support/harness";

/**
 * A spawned agent on the desktop, as the TUI presents it: Enter on a subagent row replaces the
 * whole agent draw with the child's own view (`app/agent_view/subagent_takeover.rs`), so a
 * `/goal` planner's tokens stream exactly like the main chat's. A background command keeps the
 * block viewer instead.
 */

const launch = (page: Page) => openConversation(page, shellSeed());

/** The opening brief a spawned agent runs on — longer than the three lines a prompt shows. */
const LONG_BRIEF = [
  "You are the Goal Plan Writer for the Cook harness. You run ONCE at goal creation.",
  "Convert the objective into a structured plan that the implementer, the adversarial verifiers, and the completion check will all read.",
  "Read the goal, the repository, and the pinned context first, then write the plan the goal will follow.",
  "Keep the plan short enough to be read at a glance, and make every step verifiable by someone who was not in this conversation.",
  "Write it to the episode file the harness allocated, and finish with the H1 title only.",
  "Do not run the work yourself, do not edit files outside the episode file, and do not ask the user questions.",
  "Every step must name the file or surface it touches, so a reviewer can tell whether it was done.",
].join("\n");

function spawn(page: Page, description: string, subagentType: string) {
  return page.evaluate(({ description: text, subagentType: type }) => {
    window.__cookMock!.sessionNotification({
      sessionUpdate: "subagent_spawned",
      subagent_id: "sa-1",
      child_session_id: "child-1",
      description: text,
      subagent_type: type,
    });
  }, { description, subagentType });
}

/** One child `session/update`, under the child's own session id. */
function childChunk(page: Page, update: Record<string, unknown>) {
  return page.evaluate((payload) => {
    window.__cookMock!.sessionNotification(payload, "child-1");
  }, update);
}

/**
 * A child update on the `session/update` rail carrying the child's own `promptId` — what the shell
 * actually sends while the parent's prompt is still open (a planner streams under its own turn).
 */
function childTurnChunk(page: Page, update: Record<string, unknown>, eventSuffix: number) {
  return page.evaluate(({ payload, suffix }) => {
    window.__cookMock!.sessionUpdate("child-1", payload, {
      promptId: "child-prompt",
      eventId: `child-1-${suffix}`,
    });
  }, { payload: update, suffix: eventSuffix });
}

async function openSubagent(page: Page) {
  await page.getByTestId("tasks-chip").click();
  await page.getByTestId("task-open-sa-1").click();
  await expect(page.getByTestId("subagent-takeover")).toBeVisible();
}

test.describe("subagent view", () => {
  test("opens the child's own view and streams its generation into the chat transcript", async ({ page }) => {
    await launch(page);
    await spawn(page, "[goal] Draft the implementation plan", "plan");
    await expect(page.getByTestId("tasks-chip-count")).toHaveText("1");

    await childChunk(page, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Sketching the steps" } });
    await childChunk(page, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "First I will read the tree." } });

    await openSubagent(page);

    // The frame reads like the TUI's title bar: the capitalized type, the description, the clock.
    const frame = page.getByTestId("subagent-frame");
    await expect(frame).toContainText("Plan");
    await expect(frame).toContainText("Draft the implementation plan");
    await expect(frame.locator(".subagent-frame-elapsed")).toHaveText(/^(\d+(\.\d+)?s|m\d+s)$/);

    // The child's rows are the chat's rows: streaming markdown prose, not a `<pre>` dump.
    const transcript = page.locator(".subagent-takeover .transcript");
    await expect(transcript.locator(".message-assistant .markdown")).toContainText("First I will read the tree.");
    await expect(page.getByTestId("task-viewer-output")).toHaveCount(0);

    // The child's phase rides the chat's own status row while it works.
    await expect(page.getByTestId("turn-status")).toContainText("Responding");

    // The parent is replaced, not merely covered: its composer is gone, and the takeover has no
    // prompt of its own either (`subagent_takeover.rs` draws the child's scrollback and nothing else).
    await expect(page.getByTestId("composer-input")).toHaveCount(0);
    await expect(page.getByTestId("subagent-prompt")).toHaveCount(0);
    await expect(page.getByLabel("Message this agent")).toHaveCount(0);
  });

  test("opens edits in the subagent transcript with the same row behavior", async ({ page }) => {
    await launch(page);
    await spawn(page, "Edit the workspace", "general-purpose");
    await childChunk(page, {
      sessionUpdate: "tool_call",
      toolCallId: "child-edit",
      kind: "edit",
      title: "edit",
      rawInput: { path: "src/a.ts" },
      status: "pending",
    });
    await childChunk(page, {
      sessionUpdate: "tool_call_update",
      toolCallId: "child-edit",
      kind: "edit",
      title: "edit",
      status: "completed",
      content: [{ type: "diff", path: "src/a.ts", oldText: "before", newText: "after" }],
    });
    await openSubagent(page);
    const edit = page.getByTestId("tool-row-child-edit");
    await expect(edit).toHaveAttribute("open", "");
    await expect(edit.locator(".diff-remove")).toContainText("-before");
    await expect(edit.locator(".diff-add")).toContainText("+after");
    await edit.locator("summary").click();
    await expect(edit.locator(".tool-detail")).toBeHidden();
  });

  test("streams a planner that runs while the parent's own prompt is still open", async ({ page }) => {
    // A `/goal` planner is a child session started from inside the parent's turn, so the parent's
    // prompt is in flight for the whole run and the child streams under its own prompt id.
    await openConversation(page, shellSeed({ promptDelayMs: 12_000 }));
    await page.getByTestId("composer-input").fill("plan the work");
    await page.getByTestId("send-button").click();
    await expect(page.getByTestId("turn-status")).toBeVisible();

    await spawn(page, "[goal] Draft the implementation plan", "general-purpose");
    await childTurnChunk(
      page,
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Reading the goal" } },
      12,
    );
    await childTurnChunk(
      page,
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "# Plan: ship the header" } },
      14,
    );

    await openSubagent(page);

    const transcript = page.locator(".subagent-takeover .transcript");
    // Both halves of the child's turn reached the row: its thinking (folded once the reply starts)
    // and its reply.
    await expect(transcript).toContainText(/Thought for \d/);
    await expect(transcript.locator(".message-assistant .markdown")).toContainText("# Plan: ship the header");
  });

  test("follows the stream while the viewer is open, then returns to the untouched parent chat", async ({ page }) => {
    await launch(page);
    await spawn(page, "Explore the repository", "explore");
    await childChunk(page, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Step one." } });
    await openSubagent(page);

    const transcript = page.locator(".subagent-takeover .transcript");
    await expect(transcript).toContainText("Step one.");
    await childChunk(page, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " Step two." } });
    await expect(transcript).toContainText("Step two.");

    await childChunk(page, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-1",
      title: "Execute",
      kind: "execute",
      status: "completed",
      rawInput: { command: "cargo build" },
    });
    await expect(transcript.locator(".tool-row")).toContainText("cargo build");

    await page.getByTestId("subagent-close").click();
    await expect(page.getByTestId("subagent-takeover")).toHaveCount(0);
    await expect(page.getByTestId("composer-input")).toBeVisible();
    // The child's tokens never land in the parent's own transcript.
    await expect(page.locator(".chat-layout > .chat-main .transcript")).not.toContainText("Step two.");
  });

  test("closes the child view on Escape", async ({ page }) => {
    await launch(page);
    await spawn(page, "Explore the repository", "explore");
    await openSubagent(page);

    // A child that has not streamed anything yet says so, rather than showing a blank frame.
    await expect(page.locator(".subagent-takeover .transcript")).toContainText("Nothing streamed to this agent yet.");

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("subagent-takeover")).toHaveCount(0);
    await expect(page.getByTestId("composer-input")).toBeVisible();
  });

  test("opens the agent's long brief folded, the way the TUI folds a long prompt", async ({ page }) => {
    await launch(page);
    await spawn(page, "[goal] Draft the implementation plan", "general-purpose");
    await childChunk(page, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: LONG_BRIEF },
    });
    await openSubagent(page);

    const brief = page.locator(".subagent-takeover .message-user");
    await expect(brief).toContainText("You are the Goal Plan Writer");
    const folded = (await brief.boundingBox())!;
    // Three lines of prose, not the whole brief.
    expect(folded.height).toBeLessThan(140);

    const toggle = page.getByTestId("prompt-fold-toggle");
    await expect(toggle).toHaveText("Show more");
    await toggle.click();

    const opened = (await brief.boundingBox())!;
    expect(opened.height).toBeGreaterThan(folded.height + 40);
    await expect(toggle).toHaveText("Show less");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(brief.locator(".prompt-clip")).toHaveAttribute("data-folded", "false");
  });

  test("keeps a finished child readable", async ({ page }) => {
    await launch(page);
    await spawn(page, "Explore the repository", "explore");
    await childChunk(page, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "All done here." } });
    await openSubagent(page);

    await page.evaluate(() => {
      window.__cookMock!.sessionNotification({
        sessionUpdate: "subagent_finished",
        subagent_id: "sa-1",
        status: "completed",
        duration_ms: 4_200,
      });
    });

    const transcript = page.locator(".subagent-takeover .transcript");
    await expect(transcript).toContainText("All done here.");
    await expect(page.locator(".subagent-frame-icon-completed")).toHaveCount(1);
    // Nothing is still running, so the chat's status row is gone with it.
    await expect(page.getByTestId("turn-status")).toHaveCount(0);
  });

  test("leaves a brief that fits its three lines open, with no fold to undo", async ({ page }) => {
    await launch(page);
    await spawn(page, "Explore the repository", "explore");
    await childChunk(page, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "Explore the repository and report what you find." },
    });
    await openSubagent(page);

    await expect(page.locator(".subagent-takeover .message-user")).toContainText("report what you find");
    await expect(page.getByTestId("prompt-fold-toggle")).toHaveCount(0);
  });

  test("keeps a background command a stdout viewer", async ({ page }) => {
    await launch(page);
    await page.evaluate(() => {
      window.__cookMock!.taskBackgrounded({ task_id: "bg-1", description: "Wait for server", command: "sleep 30" });
    });
    await page.getByTestId("tasks-chip").click();
    await page.getByTestId("task-open-bg-1").click();

    await expect(page.getByTestId("task-viewer-output")).toBeVisible();
    await expect(page.getByTestId("task-viewer-command")).toHaveText("sleep 30");
    await expect(page.getByTestId("subagent-takeover")).toHaveCount(0);
  });

  test("drops the child view when another conversation is opened", async ({ page }) => {
    await openConversation(page, shellSeed({
      sessions: [
        { id: "s-other", title: "Other chat", cwd: "/Users/demo/projects/cook-demo", updatedAt: "2026-09-18T10:00:00Z" },
      ],
    }));
    await spawn(page, "Explore the repository", "explore");
    await openSubagent(page);

    // A job belongs to the conversation that spawned it, so leaving for another one closes its view.
    await page.getByTestId("session-row-s-other").locator(".session-open").click();
    await expect(page.getByTestId("subagent-takeover")).toHaveCount(0);
    await expect(page.getByTestId("composer-input")).toBeVisible();
  });

  test("fills the chat column, and survives a narrow window and a light theme", async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await page.addInitScript(() => localStorage.setItem("cook.theme", "light"));
    await launch(page);
    await spawn(page, "Explore the repository", "explore");
    await childChunk(page, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "Explore the repository." },
    });
    await childChunk(page, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "A long enough line of prose that the transcript has something to paint." },
    });
    // The frame keeps its own minimum width below the layout breakpoint, so the child view only has
    // to avoid adding overflow of its own.
    const before = await page.evaluate(() => document.documentElement.scrollWidth);
    await openSubagent(page);
    const expectMessagesFillTranscript = async () => {
      const widths = await page.evaluate(() => {
        const user = document.querySelector<HTMLElement>(".subagent-takeover .message-user");
        const transcriptRow = user?.closest<HTMLElement>(".transcript-row");
        return {
          transcriptRow: transcriptRow?.getBoundingClientRect().width ?? 0,
          user: user?.getBoundingClientRect().width ?? 0,
          assistant: document.querySelector<HTMLElement>(".subagent-takeover .message-assistant")?.getBoundingClientRect().width ?? 0,
        };
      });
      expect(widths.transcriptRow).toBeGreaterThan(0);
      expect(Math.abs(widths.user - widths.transcriptRow)).toBeLessThanOrEqual(1);
      expect(Math.abs(widths.assistant - widths.transcriptRow)).toBeLessThanOrEqual(1);
    };
    await expectMessagesFillTranscript();

    // The takeover replaces the chat column rather than floating over it: it starts at the chat's
    // own edge and never runs past it.
    const main = (await page.locator("main.main-column").boundingBox())!;
    const takeover = (await page.getByTestId("subagent-takeover").boundingBox())!;
    expect(takeover.x).toBeGreaterThanOrEqual(main.x);
    expect(takeover.x + takeover.width).toBeLessThanOrEqual(main.x + main.width + 1);

    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(before);
    await expect(page.getByTestId("subagent-frame")).toBeVisible();
    await expect(page.locator(".subagent-takeover .transcript")).toBeVisible();

    // The same view at a normal desktop width keeps the frame and rows off the horizontal edge.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId("subagent-frame")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectMessagesFillTranscript();
    const wide = (await page.getByTestId("subagent-takeover").boundingBox())!;
    expect(wide.width).toBeGreaterThan(takeover.width);

    // The frame and the transcript stack inside the takeover without overlapping.
    const [frame, body] = await Promise.all([
      page.getByTestId("subagent-frame").boundingBox(),
      page.locator(".subagent-takeover .transcript").boundingBox(),
    ]);
    expect(frame!.height).toBeGreaterThan(20);
    expect(body!.y).toBeGreaterThanOrEqual(frame!.y + frame!.height);
    expect(body!.height).toBeGreaterThan(100);
    expect(body!.y + body!.height).toBeLessThanOrEqual(wide.y + wide.height + 1);
  });
});
