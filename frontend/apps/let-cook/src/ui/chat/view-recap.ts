/**
 * Start a manual `/recap` (`C-recap`): open the dialog, fire `x.ai/recap`, and wait for
 * `session_recap` / `session_recap_unavailable` on the session store.
 */
import { sessionRecap } from "../../acp/session-ops";
import { normalizeError } from "../../acp/errors";
import { useSessionStore } from "../../state/session";

export async function openRecap(): Promise<void> {
  const sessionId = useSessionStore.getState().sessionId;
  if (!sessionId) {
    useSessionStore.getState().set({ notice: "Start a conversation before asking for a recap." });
    return;
  }
  useSessionStore.getState().beginRecap();
  try {
    const result = await sessionRecap({ sessionId, auto: false });
    if (result.disabled) {
      useSessionStore.getState().failRecap("Session recap is disabled for this agent.");
    }
  } catch (error) {
    useSessionStore.getState().failRecap(normalizeError(error, "Could not create a session recap"));
  }
}
