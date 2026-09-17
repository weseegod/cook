import { useSessionStore } from "../../state/session";

/**
 * Shared View-plan action (palette + `/view-plan`):
 * review → PlanDialog; else plan entries → todo overlay; else notice.
 */
export function viewPlan(): string | null {
  const state = useSessionStore.getState();
  if (state.planReview) {
    state.setPlanDialogOpen(true);
    return null;
  }
  const hasEntries = state.blocks.some((block) => block.type === "plan" && block.entries.length > 0);
  if (hasEntries) {
    state.setTodoOverlayOpen(true);
    return null;
  }
  const notice = "No plan yet. Enter plan mode with /plan and let Thanh write one.";
  state.set({ notice });
  return notice;
}

/** Whether View plan has something to show (review body or ACP plan entries). */
export function hasViewablePlan(state: {
  planReview: unknown;
  blocks: readonly { type: string; entries?: unknown[] }[];
}): boolean {
  if (state.planReview) return true;
  return state.blocks.some((block) => block.type === "plan" && (block.entries?.length ?? 0) > 0);
}
