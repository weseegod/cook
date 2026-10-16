import { expect, test, type Page } from "@playwright/test";
import { openWorkspace, shellSeed } from "./support/harness";

const historyUpdates = Array.from({ length: 120 }, (_, index) => [
  {
    sessionUpdate: "user_message_chunk",
    messageId: `history-user-${index}`,
    content: { type: "text", text: `History question ${index}` },
  },
  {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `History answer ${index}` },
  },
]).flat();

test("a live turn keeps a bounded transcript while reading old messages", async ({ page }) => {
  await openWorkspace(page, shellSeed({ historyUpdates, promptDelayMs: 10_000 }));
  await page.getByTestId("session-row-session-login").locator(".session-open").click();
  await expect(page.locator(".transcript-row")).toHaveCount(40);

  await page.getByTestId("composer-input").fill("Continue the conversation");
  await page.getByTestId("send-button").click();
  await expect(page.locator(".message-assistant").last()).toContainText("Mock assistant reply.");
  await page.locator(".transcript").evaluate((element) => { element.scrollTop = 0; });
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();

  await expect.poll(() => page.locator(".transcript-row").count()).toBeLessThan(50);
  await expect(page.locator(".message-assistant").last()).toContainText("Mock assistant reply.");
  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect(page.locator(".message-user").last()).toContainText("Continue the conversation");
});

test("opening another conversation resets follow mode and row measurements", async ({ page }) => {
  await openWorkspace(page, shellSeed({ historyUpdates }));
  await page.getByTestId("session-row-session-login").locator(".session-open").click();
  await expect(page.locator(".transcript-row")).toHaveCount(40);
  await page.locator(".transcript").evaluate((element) => { element.scrollTop = 0; });
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();

  await page.getByTestId("session-row-session-providers").locator(".session-open").click();
  await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
  await expect(page.locator(".message-assistant").last()).toContainText("History answer 119");
});

async function streamChunks(page: Page, count: number, prefix: string) {
  for (let index = 0; index < count; index += 1) {
    await page.evaluate(
      ({ n, text }) => {
        window.__cookMock!.sessionUpdate("session-login", {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `${text}${n}` },
        });
      },
      { n: index, text: prefix },
    );
    await page.waitForTimeout(30);
  }
}

async function bottomGap(page: Page) {
  return page.locator(".transcript").evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  );
}

async function topVisibleRowId(page: Page) {
  return page.locator(".transcript").evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    for (const row of element.querySelectorAll(".transcript-row")) {
      const box = row.getBoundingClientRect();
      if (box.bottom > top + 1) return row.getAttribute("data-transcript-row");
    }
    return null;
  });
}

test("stays pinned to the bottom while a live turn streams", async ({ page }) => {
  await openWorkspace(page, shellSeed({ historyUpdates, promptDelayMs: 12_000 }));
  await page.getByTestId("session-row-session-login").locator(".session-open").click();
  await expect(page.locator(".transcript-row")).toHaveCount(40);

  await page.getByTestId("composer-input").fill("Continue the conversation");
  await page.getByTestId("send-button").click();
  await expect(page.locator(".message-assistant").last()).toContainText("Mock assistant reply.");

  const scrollTops: number[] = [];
  const gaps: number[] = [];
  for (let index = 0; index < 10; index += 1) {
    await streamChunks(page, 1, `\n\nStreaming paragraph ${index} into the live tail. `);
    scrollTops.push(await page.locator(".transcript").evaluate((element) => element.scrollTop));
    gaps.push(await bottomGap(page));
  }

  for (let index = 1; index < scrollTops.length; index += 1) {
    expect(scrollTops[index]).toBeGreaterThanOrEqual(scrollTops[index - 1] - 1);
  }
  for (const gap of gaps) {
    expect(gap).toBeLessThan(4);
  }
});

test("holds the top row while reading back as the tail streams", async ({ page }) => {
  await openWorkspace(page, shellSeed({ historyUpdates, promptDelayMs: 12_000 }));
  await page.getByTestId("session-row-session-login").locator(".session-open").click();
  await page.getByTestId("composer-input").fill("Continue the conversation");
  await page.getByTestId("send-button").click();
  await expect(page.locator(".message-assistant").last()).toContainText("Mock assistant reply.");

  await page.locator(".transcript").evaluate((element) => { element.scrollTop = 0; });
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();

  const before = await topVisibleRowId(page);
  expect(before).toBeTruthy();

  await streamChunks(page, 8, "\n\nGrow the live tail while the user reads history. ");

  const after = await topVisibleRowId(page);
  expect(after).toBe(before);
});

test("keeps the position a wheel gives it inside the last screen of a live turn", async ({ page }) => {
  await openWorkspace(page, shellSeed({ historyUpdates, promptDelayMs: 12_000 }));
  await page.getByTestId("session-row-session-login").locator(".session-open").click();
  await expect(page.locator(".transcript-row")).toHaveCount(40);

  await page.getByTestId("composer-input").fill("Continue the conversation");
  await page.getByTestId("send-button").click();
  await expect(page.locator(".message-assistant").last()).toContainText("Mock assistant reply.");
  await streamChunks(page, 4, "\n\nGrow the tail before the user scrolls back. ");

  // 60px sits inside the last screen. Follow used to re-arm anywhere within 96px of the tail, so the
  // streaming pin snapped this wheel back to the bottom on the next frame.
  const transcript = page.locator(".transcript");
  await transcript.hover();
  await page.mouse.wheel(0, -60);
  await expect.poll(() => bottomGap(page)).toBeGreaterThan(40);
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  const top = await topVisibleRowId(page);

  await streamChunks(page, 6, "\n\nKeep streaming while the user reads. ");
  expect(await bottomGap(page)).toBeGreaterThan(40);
  expect(await topVisibleRowId(page)).toBe(top);
});

test("stays manual when a scroll lands on the tail, and resumes follow on the next wheel down", async ({ page }) => {
  await openWorkspace(page, shellSeed({ historyUpdates, promptDelayMs: 12_000 }));
  await page.getByTestId("session-row-session-login").locator(".session-open").click();
  await expect(page.locator(".transcript-row")).toHaveCount(40);

  await page.getByTestId("composer-input").fill("Continue the conversation");
  await page.getByTestId("send-button").click();
  await expect(page.locator(".message-assistant").last()).toContainText("Mock assistant reply.");
  await streamChunks(page, 4, "\n\nGrow the tail before the user leaves it. ");

  const transcript = page.locator(".transcript");
  await transcript.hover();
  await page.mouse.wheel(0, -400);
  await expect.poll(() => bottomGap(page)).toBeGreaterThan(40);

  // A clamped landing on the tail is still the user's own position, so follow stays off: the tail
  // grows away from the viewport instead of being pinned back under the wheel.
  await page.mouse.wheel(0, 4_000);
  await expect.poll(() => bottomGap(page)).toBeLessThan(12);
  await streamChunks(page, 1, "\n\nGrow the tail under the clamped landing. ");
  await expect.poll(() => bottomGap(page)).toBeGreaterThan(20);

  // One more scroll-down at the tail is the overscroll gesture; follow resumes and glues the tail.
  await page.mouse.wheel(0, 4_000);
  await page.mouse.wheel(0, 120);
  await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
  await streamChunks(page, 6, "\n\nKeep streaming after follow resumed. ");
  await expect.poll(() => bottomGap(page)).toBeLessThan(4);
});

test("paints each streamed chunk into the live tail before the turn ends", async ({ page }) => {
  await openWorkspace(page, shellSeed({ promptDelayMs: 20_000 }));
  await page.getByTestId("session-row-session-login").locator(".session-open").click();
  await page.getByTestId("composer-input").fill("Answer in one growing paragraph");
  await page.getByTestId("send-button").click();

  const running = page.getByTestId("turn-status").locator(".turn-status-spinner");
  await expect(running).toBeVisible();

  const tail = page.locator(".message-assistant").last();
  for (const piece of ["First sentence. ", "Second sentence. ", "Third sentence."]) {
    await page.evaluate((text) => {
      window.__cookMock!.sessionUpdate("session-login", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      });
    }, piece);
    // The coalescer commits on the frame after the notify, so the chunk is on screen while the turn
    // is still open — the tail grows chunk by chunk instead of only at the end.
    await expect(tail).toContainText(piece.trim());
    await expect(running).toBeVisible();
  }
  await expect(tail).toContainText(/First sentence\.\s+Second sentence\.\s+Third sentence\./);
});

test("holds the position a wheel leaves mid-turn while the tail keeps streaming", async ({ page }) => {
  await openWorkspace(page, shellSeed({ historyUpdates, promptDelayMs: 12_000 }));
  await page.getByTestId("session-row-session-login").locator(".session-open").click();
  await expect(page.locator(".transcript-row")).toHaveCount(40);
  await page.getByTestId("composer-input").fill("Continue the conversation");
  await page.getByTestId("send-button").click();
  await expect(page.locator(".message-assistant").last()).toContainText("Mock assistant reply.");
  await streamChunks(page, 4, "\n\nGrow the tail before the user scrolls. ");

  const transcript = page.locator(".transcript");
  await transcript.hover();
  await page.mouse.wheel(0, -120);
  await expect.poll(() => bottomGap(page)).toBeGreaterThan(40);
  const parked = await transcript.evaluate((element) => element.scrollTop);

  // The wheel parked the pane above the tail. The streaming pin stands aside for the gesture and
  // `scrollend`, so the viewport stays where the user left it for the whole stream instead of
  // snapping back part way through.
  for (let index = 0; index < 10; index += 1) {
    await streamChunks(page, 1, `\n\nKeep streaming under the parked position ${index}. `);
    expect(await transcript.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(parked + 8);
    expect(await bottomGap(page)).toBeGreaterThan(40);
  }
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
});

test("keeps the position a scrollbar-style scroll leaves while the tail streams", async ({ page }) => {
  await openWorkspace(page, shellSeed({ historyUpdates, promptDelayMs: 12_000 }));
  await page.getByTestId("session-row-session-login").locator(".session-open").click();
  await expect(page.locator(".transcript-row")).toHaveCount(40);

  await page.getByTestId("composer-input").fill("Continue the conversation");
  await page.getByTestId("send-button").click();
  await expect(page.locator(".message-assistant").last()).toContainText("Mock assistant reply.");
  await streamChunks(page, 4, "\n\nGrow the tail before the user scrolls back. ");

  const transcript = page.locator(".transcript");
  // A scrollbar drag, a key, or any other driver the wheel path does not see: the pane gets no
  // wheel/touch/pointer event on `.transcript`, so the guard has to come from the scroll event
  // itself, and the pane must leave a position it did not write alone.
  const parked = await transcript.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollTop - 1_200);
    return element.scrollTop;
  });
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  await page.waitForTimeout(300);
  const settled = await transcript.evaluate((element) => element.scrollTop);
  const top = await topVisibleRowId(page);

  await streamChunks(page, 8, "\n\nKeep streaming under the parked position ");
  expect(settled).toBeGreaterThanOrEqual(parked - 8);
  expect(settled).toBeLessThanOrEqual(parked + 8);
  expect(await transcript.evaluate((element) => element.scrollTop)).toBeGreaterThanOrEqual(settled - 8);
  expect(await transcript.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(settled + 8);
  expect(await topVisibleRowId(page)).toBe(top);
});

test("keeps the reading line on the wheel while rows taller than the estimate mount", async ({ page }) => {
  // 80-item markdown lists make every assistant row ~1,900px against the model's 72px estimate, and
  // 34 pairs leave the rows above the tail slice unmounted. Wheeling into them mounts rows at their
  // real height, which drops the content below by the difference; the pane's anchor restore is the
  // only thing that keeps the reader's line still, and it has to keep running while the wheel does.
  const tallHistoryUpdates = Array.from({ length: 34 }, (_, index) => [
    {
      sessionUpdate: "user_message_chunk",
      messageId: `tall-user-${index}`,
      content: { type: "text", text: `History question ${index}` },
    },
    {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: Array.from({ length: 80 }, (_, line) => `- Tall history line ${index}-${line}`).join("\n"),
      },
    },
  ]).flat();

  await openWorkspace(page, shellSeed({ historyUpdates: tallHistoryUpdates }));
  await page.getByTestId("session-row-session-login").locator(".session-open").click();
  await expect(page.locator(".transcript-row")).toHaveCount(40);

  const transcript = page.locator(".transcript");
  await transcript.hover();
  // Walk up to the rows the model only estimated: from here every wheel mounts fresh tall rows.
  for (let index = 0; index < 15; index += 1) {
    await page.mouse.wheel(0, -2_000);
    await page.waitForTimeout(240);
  }

  // One row under the viewport top, watched for the whole burst: it stands in for the line the
  // reader is on, and `scrollTop - offsetTop` is that line's place in the transcript's own layout.
  const sampling = transcript.evaluate((element) => new Promise<string[]>((resolve) => {
    const top = element.getBoundingClientRect().top;
    const rows = [...element.querySelectorAll<HTMLElement>(".transcript-row")];
    const markerId = rows.find((row) => row.getBoundingClientRect().bottom > top + 1)
      ?.getAttribute("data-transcript-row") ?? null;
    const samples: string[] = [];
    const deadline = performance.now() + 3_000;
    const tick = () => {
      const marker = markerId
        ? element.querySelector<HTMLElement>(`[data-transcript-row="${CSS.escape(markerId)}"]`)
        : null;
      samples.push(marker ? String(Math.round(element.scrollTop - marker.offsetTop)) : "-");
      if (performance.now() > deadline) resolve(samples);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));

  await page.waitForTimeout(80);
  await transcript.hover();
  const wheels = 16;
  for (let index = 0; index < wheels; index += 1) {
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(25);
  }

  const samples = (await sampling).filter((sample) => sample !== "-");
  expect(samples.length).toBeGreaterThan(20);
  const positions = samples.map(Number);

  // The burst scrolled the reading line up by its own 9,600px of wheel, not by a mounted row's
  // height on top of that.
  const travelled = positions[0] - positions.at(-1)!;
  expect(travelled).toBeGreaterThan(wheels * 600 * 0.9);
  expect(travelled).toBeLessThan(wheels * 600 * 1.15);

  // No frame moves the reader further than the wheel step it was answering.
  for (let index = 1; index < positions.length; index += 1) {
    expect(positions[index - 1] - positions[index]).toBeLessThan(900);
  }
});

test("keeps a wheel position near the tail on an idle transcript", async ({ page }) => {
  await openWorkspace(page, shellSeed({ historyUpdates }));
  await page.getByTestId("session-row-session-login").locator(".session-open").click();
  await expect(page.locator(".transcript-row")).toHaveCount(40);

  const transcript = page.locator(".transcript");
  await transcript.hover();
  await page.mouse.wheel(0, -120);
  await expect.poll(() => bottomGap(page)).toBeGreaterThan(40);
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();

  // No turn is running, so nothing streams; the only thing that changes is the virtualizer mounting
  // and measuring the rows the wheel brought on screen. That measurement must not move the reader.
  const parked = await transcript.evaluate((element) => element.scrollTop);
  const top = await topVisibleRowId(page);
  await page.waitForTimeout(500);
  await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeGreaterThanOrEqual(parked - 8);
  expect(await transcript.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(parked + 8);
  expect(await topVisibleRowId(page)).toBe(top);
});

test("Jump to latest reaches the tail when the click follows a drag", async ({ page }) => {
  await openWorkspace(page, shellSeed({ historyUpdates, promptDelayMs: 12_000 }));
  await page.getByTestId("session-row-session-login").locator(".session-open").click();
  await expect(page.locator(".transcript-row")).toHaveCount(40);

  await page.getByTestId("composer-input").fill("Continue the conversation");
  await page.getByTestId("send-button").click();
  await expect(page.locator(".message-assistant").last()).toContainText("Mock assistant reply.");
  await streamChunks(page, 4, "\n\nGrow the tail before the user scrolls back. ");

  const transcript = page.locator(".transcript");
  await transcript.hover();
  await page.mouse.wheel(0, -150);
  await expect.poll(() => bottomGap(page)).toBeGreaterThan(40);
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();

  // The click lands while the wheel's gesture window is still warm. It has to win: the tail belongs
  // on screen and the button has to go, even though the commit that swaps the window changes the
  // scroll extent under a guard that was armed for the user's drag.
  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
  await expect.poll(() => bottomGap(page)).toBeLessThan(4);

  await streamChunks(page, 6, "\n\nKeep streaming after the jump landed. ");
  await expect.poll(() => bottomGap(page)).toBeLessThan(4);
  await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
});
