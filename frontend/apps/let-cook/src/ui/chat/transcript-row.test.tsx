import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageBlock } from "../../state/session";
import { Message } from "./transcript-row";

const prompt = (text: string): MessageBlock => ({
  type: "message",
  id: "user-1",
  turnId: "turn-1",
  role: "user",
  text,
  images: [],
  streaming: false,
});

/**
 * jsdom reports every box as 0×0, so the two numbers the fold reads are stubbed here: the folded
 * box's `clientHeight` against the whole prompt's `scrollHeight`.
 */
function stubPromptHeights(full: number, shown: number) {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("prompt-clip") ? shown : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("prompt-clip") ? full : 0;
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a user prompt row", () => {
  it("clamps a prompt that does not fit three lines and offers the way out", () => {
    stubPromptHeights(240, 60);
    const { container } = render(<Message block={prompt("one\ntwo\nthree\nfour\nfive")} />);

    expect(container.querySelector(".prompt-clip")).toHaveAttribute("data-folded", "true");
    expect(screen.getByTestId("prompt-fold-toggle")).toHaveTextContent("Show more");
  });

  it("opens on click and stays open while the row stays clipped", () => {
    stubPromptHeights(240, 60);
    const { container } = render(<Message block={prompt("one\ntwo\nthree\nfour\nfive")} />);

    fireEvent.click(screen.getByTestId("prompt-fold-toggle"));

    expect(container.querySelector(".prompt-clip")).toHaveAttribute("data-folded", "false");
    const toggle = screen.getByTestId("prompt-fold-toggle");
    expect(toggle).toHaveTextContent("Show less");
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    // Opening is not a one-way door: the row folds back.
    fireEvent.click(toggle);
    expect(container.querySelector(".prompt-clip")).toHaveAttribute("data-folded", "true");
  });

  it("leaves a prompt its three lines can hold unfolded, with no control to offer", () => {
    stubPromptHeights(40, 60);
    const { container } = render(<Message block={prompt("Create the file.")} />);

    expect(container.querySelector(".prompt-clip")).toHaveAttribute("data-folded", "false");
    expect(screen.queryByTestId("prompt-fold-toggle")).toBeNull();
  });

  it("folds an assistant reply only through its own rows, never as a prompt", () => {
    stubPromptHeights(240, 60);
    const { container } = render(<Message block={{ ...prompt("one\ntwo\nthree\nfour"), role: "assistant" }} />);

    expect(container.querySelector(".prompt-clip")).toBeNull();
    expect(screen.queryByTestId("prompt-fold-toggle")).toBeNull();
  });
});
