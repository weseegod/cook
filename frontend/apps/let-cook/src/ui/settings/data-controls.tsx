import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { acpClient } from "../../acp/client";
import { normalizeError } from "../../acp/errors";
import { useSessionStore } from "../../state/session";
import { ConfirmDialog } from "../components/dialog";
import { DEFAULT_PREFS, savePrefs } from "../sessions/session-sidebar-utils";

/**
 * Settings → Data Controls: what this machine stores, and the one action that erases it.
 *
 * The erasure runs in the agent (`x.ai/sessions/delete_all`), which is the only side that knows
 * where the conversations and their plan files live. The panel reports the counts the agent
 * returns rather than the rows the sidebar happens to be showing, so a wipe that could not finish
 * says so instead of claiming success.
 */
export function DataControlsPanel({ connected }: { connected: boolean }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function eraseEverything() {
    setBusy(true);
    setError(null);
    try {
      const result = await acpClient.xai.deleteAllSessions();
      // The open conversation is gone with the rest, so drop it before the sidebar refetches.
      useSessionStore.getState().resetConversation();
      // Pinned and manually ordered rows point at ids that no longer exist.
      savePrefs(DEFAULT_PREFS);
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      setConfirming(false);
      const conversations = `${result.deleted} conversation${result.deleted === 1 ? "" : "s"}`;
      const plans = `${result.plansDeleted} plan file${result.plansDeleted === 1 ? "" : "s"}`;
      useSessionStore.getState().set(
        result.failed > 0
          ? { error: `Deleted ${conversations} and ${plans}; ${result.failed} could not be deleted.` }
          : { notice: `Deleted ${conversations} and ${plans}.` },
      );
    } catch (caught) {
      setError(normalizeError(caught, "Could not delete the conversations"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="data-controls">
      <div className="data-control-danger">
        <div className="data-control-copy">
          <strong>Delete all conversations</strong>
          <span>
            Erases every conversation in every workspace on this machine, including their plan
            files. This cannot be undone.
          </span>
        </div>
        <button
          type="button"
          className="danger-button"
          data-testid="delete-all-conversations"
          disabled={!connected}
          title={connected ? "Delete every conversation and plan file" : "Connect the agent first"}
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
        >
          <Trash2 size={15} /> Delete all conversations
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          title="Delete all conversations?"
          description={
            <>
              Every conversation in every workspace on this machine is erased, together with the
              plan files each one produced. The agent removes them from this disk, and from the
              cloud copy when this account stores sessions there. This cannot be undone.
            </>
          }
          confirmLabel="Delete everything"
          confirmTestId="delete-all-confirm"
          danger
          busy={busy}
          error={error}
          onCancel={() => {
            setConfirming(false);
            setError(null);
          }}
          onConfirm={() => void eraseEverything()}
        />
      )}
    </div>
  );
}
