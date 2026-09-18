import { useSessionStore } from "../../state/session";

/**
 * The header's `plan` chip (`app/agent_view/render.rs`: the status bar pushes a `plan` chip before
 * the goal chip). Visible whenever the session holds a plan — a parked review or the body of one
 * already answered — and clicking it opens the plan surface.
 */
export function PlanChip() {
  const review = useSessionStore((state) => state.planReview);
  const open = useSessionStore((state) => state.setPlanDialogOpen);
  if (!review) return null;
  return (
    <button
      type="button"
      className="plan-chip"
      data-testid="plan-chip"
      title="View plan"
      onClick={() => open(true)}
    >
      plan
    </button>
  );
}
