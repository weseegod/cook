import { acpClient } from "../../acp/client";
import { normalizeError } from "../../acp/errors";
import { useSessionStore } from "../../state/session";

/** Follow-up suggestion chips under the composer (`x.ai/follow_ups` / N-follow). */
export function FollowUps() {
  const followUps = useSessionStore((state) => state.followUps);
  const turnRunning = useSessionStore((state) => state.turnRunning);
  if (!followUps || followUps.suggestions.length === 0 || turnRunning) return null;

  async function send(label: string) {
    useSessionStore.getState().set({ followUps: null });
    try {
      await acpClient.prompt(label);
    } catch (error) {
      useSessionStore.getState().set({
        error: normalizeError(error, "Could not send the follow-up"),
      });
    }
  }

  return (
    <div className="follow-ups" data-testid="follow-ups" role="group" aria-label="Suggested follow-ups">
      {followUps.suggestions.map((label) => (
        <button
          key={label}
          type="button"
          className="follow-up-chip"
          title={label}
          onClick={() => void send(label)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
