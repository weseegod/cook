import { create } from "zustand";

/** The utility views the shell can be asked to bring up. */
export type ToolsPanelView = "review" | "files" | "activity" | "preview";

interface ToolsPanelState {
  /** Bumped per request, so asking again after a manual tab switch still lands on the target. */
  nonce: number;
  target: ToolsPanelView | null;
  request: (target: ToolsPanelView) => void;
  clearTarget: () => void;
}

/**
 * Which utility view the shell should show. The header's line-change rail asks for Review this way,
 * the same as `/tasks` asks for the activity dock: the shell owns whether the panel is on screen,
 * and the panel reads the target once it is mounted.
 */
export const useToolsPanelStore = create<ToolsPanelState>((set) => ({
  nonce: 0,
  target: null,
  request: (target) => set((state) => ({ nonce: state.nonce + 1, target })),
  clearTarget: () => set({ target: null }),
}));
