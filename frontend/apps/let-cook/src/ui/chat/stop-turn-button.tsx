import { Square } from "lucide-react";
import { useState } from "react";
import { acpClient } from "../../acp/client";
import { normalizeError } from "../../acp/errors";
import { useSessionStore } from "../../state/session";

export function StopTurnButton() {
  const [stopping, setStopping] = useState(false);

  async function stop() {
    if (stopping) return;
    setStopping(true);
    try {
      await acpClient.cancel();
    } catch (error) {
      useSessionStore.getState().set({ error: normalizeError(error, "Could not stop the turn") });
    } finally {
      setStopping(false);
    }
  }

  return (
    <button type="button" className="stop-button" data-testid="stop-button" disabled={stopping} onClick={() => void stop()}>
      <Square size={12} fill="currentColor" aria-hidden="true" /> Stop
    </button>
  );
}
