import {
  clearQueuedPrompts,
  editQueuedPrompt,
  holdQueuedPromptEdit,
  releaseQueuedPromptEdit,
  removeQueuedPrompt,
  sendQueuedPromptNow,
} from "../../acp/turn-ops";
import { normalizeError } from "../../acp/errors";
import { useSessionStore, type QueuedPromptEntry } from "../../state/session";
import { isSendableWait, resolveTurnActivity } from "./turn-activity";

/** Compact queue list above turn-status (`x.ai/queue/changed` + TUI §9.7 chips). */
export function QueueBar() {
  const sessionId = useSessionStore((state) => state.sessionId);
  const entries = useSessionStore((state) => state.queuedEntries);
  const turnRunning = useSessionStore((state) => state.turnRunning);
  const activity = useSessionStore((state) => state.activity);
  const goalVerifying = useSessionStore((state) => state.goal?.verifyingCompletion === true);
  const pendingQuestion = useSessionStore((state) => state.pendingQuestion);
  const editingId = useSessionStore((state) => state.editingQueueEntry?.id ?? null);

  if (!sessionId || entries.length === 0) return null;

  const resolved = resolveTurnActivity({
    derived: activity,
    turnRunning,
    goalVerifying,
    askDetail: pendingQuestion?.kind === "question" ? pendingQuestion.title ?? "" : null,
  });
  // TUI `can_send_now`: turn running or a sendable wait (empty Enter / Send now chip).
  const canSendNow = turnRunning || isSendableWait(resolved);

  return (
    <div className="queue-bar" data-testid="queue-bar" role="list" aria-label="Queued prompts">
      <div className="queue-bar-header">
        <strong>{entries.length} queued</strong>
        <button
          type="button"
          className="text-button"
          data-testid="queue-clear"
          onClick={() => void clearQueuedPrompts(sessionId).catch(reportError)}
        >
          Clear
        </button>
      </div>
      <ul className="queue-bar-list">
        {entries.map((entry, index) => (
          <li key={entry.id} className="queue-bar-row" role="listitem">
            <span className="queue-bar-index">#{index + 1}</span>
            <span className="queue-bar-text" title={entry.text}>{entry.text || entry.kind || entry.id}</span>
            <span className="queue-bar-actions">
              {canSendNow && (
                <button
                  type="button"
                  className="queue-bar-chip"
                  data-testid={`queue-send-now-${entry.id}`}
                  disabled={editingId === entry.id}
                  onClick={() => void sendNow(sessionId, entry).catch(reportError)}
                >
                  Send now
                </button>
              )}
              <button
                type="button"
                className="queue-bar-chip"
                data-testid={`queue-edit-${entry.id}`}
                disabled={editingId === entry.id}
                onClick={() => void beginEdit(sessionId, entry).catch(reportError)}
              >
                edit
              </button>
              <button
                type="button"
                className="queue-bar-chip"
                aria-label={`Remove queued prompt ${index + 1}`}
                data-testid={`queue-remove-${entry.id}`}
                onClick={() => void removeQueuedPrompt(sessionId, entry.id, entry.version).catch(reportError)}
              >
                cancel
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

async function sendNow(sessionId: string, entry: QueuedPromptEntry) {
  await sendQueuedPromptNow(sessionId, entry.id, entry.version);
}

async function beginEdit(sessionId: string, entry: QueuedPromptEntry) {
  const store = useSessionStore.getState();
  const previous = store.editingQueueEntry;
  if (previous && previous.id !== entry.id) {
    await releaseQueuedPromptEdit(sessionId, previous.id).catch(() => undefined);
  }
  await holdQueuedPromptEdit(sessionId, entry.id);
  store.set({
    editingQueueEntry: { id: entry.id, version: entry.version },
    composerDraft: entry.text,
    notice: null,
    error: null,
  });
}

function reportError(error: unknown) {
  useSessionStore.getState().set({
    error: normalizeError(error, "Could not update the prompt queue"),
  });
}

/** Save the composer draft back into the held queue row (composer Save path). */
export async function saveQueueEdit(sessionId: string, id: string, newText: string): Promise<void> {
  await editQueuedPrompt(sessionId, id, newText);
  await releaseQueuedPromptEdit(sessionId, id);
  useSessionStore.getState().set({
    editingQueueEntry: null,
    composerDraft: "",
  });
}

/** Esc / cancel edit — release hold without saving. */
export async function cancelQueueEdit(sessionId: string, id: string): Promise<void> {
  await releaseQueuedPromptEdit(sessionId, id);
  useSessionStore.getState().set({
    editingQueueEntry: null,
    composerDraft: "",
  });
}
