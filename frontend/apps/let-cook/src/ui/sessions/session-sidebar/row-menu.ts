import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";

/** Room the full conversation menu needs below its trigger before it flips upwards. */
export const ROW_MENU_HEIGHT = 220;

export interface RowMenu {
  id: string;
  top: number | null;
  bottom: number | null;
  right: number;
  trigger: HTMLElement;
}

/** Anchor a row menu to its trigger, flipping it above when the viewport bottom is near. */
export function rowMenuPosition(trigger: HTMLElement): Omit<RowMenu, "id" | "trigger"> {
  const rect = trigger.getBoundingClientRect();
  const openUp = rect.bottom + ROW_MENU_HEIGHT > window.innerHeight;
  return {
    top: openUp ? null : rect.bottom + 4,
    bottom: openUp ? window.innerHeight - rect.top + 4 : null,
    right: Math.max(6, window.innerWidth - rect.right),
  };
}

/** Close the open row menu on an outside press, or on Escape without letting it bubble. */
export function useRowMenuDismiss(
  rowMenu: RowMenu | null,
  menuRef: RefObject<HTMLDivElement | null>,
  setRowMenu: Dispatch<SetStateAction<RowMenu | null>>,
) {
  useEffect(() => {
    if (!rowMenu) return;
    const trigger = rowMenu.trigger;
    function onPointerDown(event: MouseEvent) {
      const node = event.target as Node;
      if (menuRef.current?.contains(node) || trigger.contains(node)) return;
      setRowMenu(null);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setRowMenu(null);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [rowMenu]);
}
