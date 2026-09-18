import { X } from "lucide-react";
import { clearQueuedPrompts, removeQueuedPrompt } from "../../acp/turn-ops";
import { useSessionStore } from "../../state/session";

/** Compact queue list above the composer (`x.ai/queue/changed` + C-q-rm / C-q-cl). */
export function QueueBar() {
  const sessionId = useSessionStore((state) => state.sessionId);
  const entries = useSessionStore((state) => state.queuedEntries);
  if (!sessionId || entries.length === 0) return null;

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
            <button
              type="button"
              className="icon-button"
              aria-label={`Remove queued prompt ${index + 1}`}
              data-testid={`queue-remove-${entry.id}`}
              onClick={() => void removeQueuedPrompt(sessionId, entry.id, entry.version).catch(reportError)}
            >
              <X size={12} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function reportError(error: unknown) {
  useSessionStore.getState().set({
    error: error instanceof Error ? error.message : String(error),
  });
}
