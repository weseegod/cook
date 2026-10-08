import { useSessionStore, type StashedInteraction, type TurnOutcome } from "../state/session";
import { notifyWhileUnfocused } from "./os-notify";

/**
 * A blocking request for a conversation that is not on screen. The agent stays parked on the
 * reverse-request, so the card is kept with its conversation; the toast and the native
 * notification are how the user learns the conversation is waiting.
 */
export function parkBackgroundInteraction(
  sessionId: string,
  interaction: StashedInteraction,
  copy: { title: string; body: string },
): void {
  const store = useSessionStore.getState();
  store.stashInteraction(sessionId, interaction);
  store.pushToast({
    tone: "info",
    title: copy.title,
    body: copy.body,
    sessionId,
  });
  void notifyWhileUnfocused("Let Cook", copy.body);
}

/**
 * A turn that ended while another conversation was open. The outcome belongs to the conversation
 * that ran it, so it becomes an alert there and a toast here — the open chat's banner and
 * composer are left alone.
 */
export function reportBackgroundTurnOutcome(sessionId: string, outcome: TurnOutcome): void {
  const store = useSessionStore.getState();
  if (outcome.kind === "cancelled") return;
  if (outcome.kind === "failed") {
    const message = outcome.error ?? "The turn failed";
    store.setSessionAlert(sessionId, message);
    store.pushToast({ tone: "error", title: "Turn failed", body: message, sessionId, sticky: true });
    void notifyWhileUnfocused("Let Cook", "A turn failed in another conversation");
    return;
  }
  store.pushToast({
    tone: "success",
    title: "Turn completed",
    body: "A conversation finished while you were away.",
    sessionId,
  });
  void notifyWhileUnfocused("Let Cook", "A turn completed in another conversation");
}
