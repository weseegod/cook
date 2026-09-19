/** Viewport gutter a header popover keeps on every side. */
const GUTTER = 12;

/** The chat area a popover sizes itself against: the whole chat region below the header. */
function chatBox(): DOMRect | null {
  const area = document.querySelector(".chat-layout") ?? document.querySelector(".chat-main");
  const rect = area?.getBoundingClientRect();
  return rect && rect.width > 0 ? rect : null;
}

/**
 * Anchors a header popover to the left edge of the chip that opened it, and keeps it inside the
 * window.
 *
 * Both header chips sit in the header's left cluster, so their popovers hang off the trigger's
 * left edge and grow right — over the transcript, never over the conversation list beside it. Only
 * a window too narrow for that shifts the popover, and never past the viewport gutter.
 */
export function clampMenuToViewport(node: HTMLElement, parent: HTMLElement, gutter = 6): void {
  node.style.right = "auto";
  node.style.left = "0px";
  node.style.width = "";
  const rect = node.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();
  const width = Math.min(rect.width, window.innerWidth - gutter * 2);
  node.style.width = `${width}px`;
  const shift = Math.min(0, window.innerWidth - gutter - (parentRect.left + width));
  node.style.left = `${Math.max(gutter - parentRect.left, shift)}px`;
}

/** Widest a popover grows on a very wide window, whatever its symmetric span measures. */
const MAX_WIDTH = 720;

/** Height cap the plans list uses; the tasks list matches it so the two read as one family. */
export const MENU_MAX_HEIGHT = 320;

/**
 * Centres a header popover on the chat while starting it at the trigger's left edge: the span to
 * the right mirrors the trigger-to-chat-centre span. This keeps the Tasks menu visually centred
 * without making its left edge drift away from the button, and it is as tall as the plans list
 * before it scrolls.
 *
 * The popover hangs below its chip either way, and never leaves the viewport — in a window too
 * narrow for half the chat it falls back to the viewport gutter.
 */
export function placeMenuOverChat(node: HTMLElement, parent: HTMLElement): void {
  const box = chatBox();
  const area = box ?? { x: 0, width: window.innerWidth, height: window.innerHeight };
  const parentLeft = parent.getBoundingClientRect().left;
  const chatCentre = area.x + area.width / 2;
  const widthFromTrigger = Math.max(0, (chatCentre - parentLeft) * 2);
  const width = Math.min(widthFromTrigger, MAX_WIDTH, window.innerWidth - GUTTER * 2);
  const centred = chatCentre - width / 2 - parentLeft;
  const left = Math.max(
    GUTTER - parentLeft,
    Math.min(centred, window.innerWidth - GUTTER - width - parentLeft),
  );
  node.style.right = "auto";
  node.style.width = `${width}px`;
  node.style.maxHeight = `${Math.min(MENU_MAX_HEIGHT, area.height - GUTTER * 2)}px`;
  node.style.left = `${left}px`;
}
