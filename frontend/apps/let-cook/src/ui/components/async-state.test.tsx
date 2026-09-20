import { render, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoadingState } from "./async-state";
import { BRAILLE_FRAMES } from "../chat/turn-activity";

describe("LoadingState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("animates a braille spinner so loading stays visible under reduced motion", () => {
    render(<LoadingState label="Loading connectors" />);
    const status = screen.getByTestId("settings-loading");
    expect(status).toHaveTextContent("Loading connectors");
    const spinner = status.querySelector(".async-state-spinner");
    expect(spinner?.textContent).toBe(BRAILLE_FRAMES[0]);

    act(() => {
      vi.advanceTimersByTime(140);
    });
    expect(spinner?.textContent).toBe(BRAILLE_FRAMES[1]);
  });
});
