import { useEffect, useState } from "react";

/** Keep the TUI's 30 fps capability while painting the braille spinner at roughly 7.5 fps. */
const FRAME_MS = 1000 / 30;
export const SPINNER_DIVISOR = 4;
const INTERVAL_MS = FRAME_MS * SPINNER_DIVISOR;

/**
 * Advances one spinner frame every {@link INTERVAL_MS} while `active`, and parks on frame 0 while
 * idle. Shared by the chat's activity row and the conversation list's copy of it, so the two spin
 * in step.
 */
export function useSpinFrame(active: boolean): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) {
      setFrame(0);
      return;
    }
    const timer = window.setInterval(() => setFrame((value) => value + 1), INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active]);
  return frame;
}
