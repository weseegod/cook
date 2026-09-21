import { useSessionStore } from "../../state/session";
import { PermissionModal } from "../permissions/permission-modal";
import { InteractionModal } from "../permissions/interaction-modal";
import { Composer } from "./composer";
import { FollowUps } from "./follow-ups";

/**
 * Prompt-slot occupancy (catalog §9): one of Composer or a blocking card.
 * Composer stays mounted so a half-written draft and attachments survive the interruption.
 * Parked plan review is not a card — the composer stays live for request-changes.
 * Queue pane lives above turn-status in ChatView (TUI §3 / §9.7), not here.
 */
export function PromptSlot() {
  const pendingPermission = useSessionStore((state) => state.pendingPermission);
  const pendingQuestion = useSessionStore((state) => state.pendingQuestion);
  const blocking =
    Boolean(pendingPermission) ||
    (Boolean(pendingQuestion) && pendingQuestion?.kind !== "plan");

  return (
    <div className="prompt-slot">
      {blocking && (
        <>
          <PermissionModal />
          <InteractionModal />
        </>
      )}
      <div className={blocking ? "prompt-composer stashed" : "prompt-composer"}>
        <Composer />
        <FollowUps />
      </div>
    </div>
  );
}
