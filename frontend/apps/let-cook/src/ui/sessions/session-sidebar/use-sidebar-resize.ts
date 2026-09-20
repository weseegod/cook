import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { clampSidebarWidth, type ConversationPrefs } from "../session-sidebar-utils";

/** Arrow-key step, and its bigger step with Shift held. */
const RESIZE_STEP = 16;
const RESIZE_STEP_LARGE = 48;

/** Drag and arrow-key resizing for the sidebar, plus the live width it paints while dragging. */
export function useSidebarResize({
  prefs,
  prefsRef,
  updatePrefs,
}: {
  prefs: ConversationPrefs;
  prefsRef: RefObject<ConversationPrefs>;
  updatePrefs: (next: ConversationPrefs) => void;
}) {
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const asideRef = useRef<HTMLElement>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const liveWidthRef = useRef<number | null>(null);
  const sidebarWidth = liveWidth ?? prefs.width;

  useEffect(() => {
    if (liveWidth === null) return undefined;
    function onPointerMove(event: PointerEvent) {
      const start = resizeRef.current;
      if (!start) return;
      event.preventDefault();
      setLive(clampSidebarWidth(start.startWidth + (event.clientX - start.startX)));
    }
    function onPointerUp() {
      const width = liveWidthRef.current ?? prefsRef.current.width;
      resizeRef.current = null;
      document.body.classList.remove("session-resizing");
      setLive(null);
      updatePrefs({ ...prefsRef.current, width });
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [liveWidth]);

  function setLive(width: number | null) {
    liveWidthRef.current = width;
    setLiveWidth(width);
  }

  function beginResize(event: ReactPointerEvent<HTMLDivElement>) {
    const aside = asideRef.current;
    if (event.button !== 0 || !aside) return;
    event.preventDefault();
    const startWidth = aside.getBoundingClientRect().width;
    resizeRef.current = { startX: event.clientX, startWidth };
    document.body.classList.add("session-resizing");
    setLive(Math.round(startWidth));
  }

  function resizeByKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.shiftKey ? RESIZE_STEP_LARGE : RESIZE_STEP;
    const current = sidebarWidth ?? asideRef.current?.getBoundingClientRect().width;
    if (current === undefined) return;
    updatePrefs({ ...prefs, width: clampSidebarWidth(current + (event.key === "ArrowRight" ? step : -step)) });
  }

  return { sidebarWidth, asideRef, beginResize, resizeByKey };
}
