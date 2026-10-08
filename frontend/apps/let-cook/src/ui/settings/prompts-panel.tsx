import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, RotateCcw, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { normalizeError } from "../../acp/errors";
import {
  listPrompts,
  readPrompt,
  restorePrompt,
  writePrompt,
  type PromptEntryView,
  type PromptState,
} from "../../acp/extensions";
import { EmptyState, ErrorState, LoadingState } from "../components/async-state";
import { ConfirmDialog, Dialog } from "../components/dialog";

const STATE_LABEL: Record<PromptState, string> = {
  absent: "No copy",
  unmodified: "Unmodified",
  modified: "Modified",
};

/**
 * Settings → Prompts: the user-editable copies of the shell's prompt templates under
 * `<cook home>/prompts/`. Defaults are compiled into the binary; a copy here overrides one at
 * runtime, and Reset writes the shipped text back.
 */
export function PromptsPanel({ connected }: { connected: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<PromptEntryView | null>(null);

  const prompts = useQuery({
    queryKey: ["prompts"],
    queryFn: listPrompts,
    enabled: connected,
    staleTime: 0,
    retry: 0,
  });

  const list = prompts.data?.prompts ?? [];
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["prompts"] });

  return (
    <div className="prompts-panel">
      {!connected && <p className="settings-note">Connect the agent to edit prompt files.</p>}
      {connected && prompts.isLoading && <LoadingState label="Loading prompts" />}
      {prompts.isError && (
        <ErrorState label={normalizeError(prompts.error, "Could not load prompts from the agent.")} />
      )}
      {connected && prompts.isSuccess && list.length === 0 && (
        <EmptyState label="No editable prompts" detail="This agent build has no prompt overrides to offer." />
      )}
      {connected && list.length > 0 && (
        <>
          <p className="settings-note" data-testid="prompts-summary">
            {list.length} prompt{list.length === 1 ? "" : "s"} · edits apply to every session
          </p>
          <p className="settings-note" data-testid="prompts-warning">
            A file you change stops receiving updates from the app; press Reset to return to the shipped
            prompt. Keep <code>{"${...}"}</code> placeholders intact — removing one can break the prompt.
          </p>
          <ul className="prompt-list">
            {list.map((entry) => (
              <li key={entry.relative}>
                <button
                  type="button"
                  className="prompt-row"
                  data-testid={`prompt-open-${entry.relative}`}
                  onClick={() => setOpen(entry)}
                >
                  <code>{entry.relative}</code>
                  <span className={`prompt-state prompt-state-${entry.state}`}>{STATE_LABEL[entry.state]}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {open && (
        <PromptViewerDialog
          entry={open}
          connected={connected}
          onClose={() => setOpen(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

/**
 * One prompt's text, read from the agent, with an Edit mode that writes the user's copy and a
 * Reset that restores the compiled default byte for byte.
 */
export function PromptViewerDialog({
  entry,
  connected,
  onClose,
  onChanged,
}: {
  entry: PromptEntryView;
  connected: boolean;
  onClose: () => void;
  /** Called after a write or reset, so the caller can refetch the list and its states. */
  onChanged: () => void;
}) {
  const relative = entry.relative;
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const file = useQuery({
    queryKey: ["prompt", relative],
    queryFn: () => readPrompt(relative),
    enabled: connected,
    retry: 0,
  });

  // Seed the editor once per prompt: a refetch must not overwrite what the user is typing.
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!file.isSuccess || seeded.current === relative) return;
    seeded.current = relative;
    setDraft(file.data?.content ?? file.data?.default ?? "");
  }, [file.isSuccess, file.data, relative]);

  const state = file.data?.state ?? entry.state;

  const save = useMutation({
    mutationFn: () => writePrompt(relative, draft),
    onSuccess: (written) => {
      setEditing(false);
      setStatus(written.state === "unmodified" ? "Saved — identical to the default" : "Saved");
      seeded.current = relative;
      onChanged();
      void queryClient.invalidateQueries({ queryKey: ["prompt", relative] });
    },
    onError: (error) => setStatus(normalizeError(error, "Could not save this prompt")),
  });

  const reset = useMutation({
    mutationFn: () => restorePrompt(relative),
    onSuccess: () => {
      setConfirmReset(false);
      setEditing(false);
      setStatus("Reset to the shipped prompt");
      seeded.current = null;
      onChanged();
      void queryClient.invalidateQueries({ queryKey: ["prompt", relative] });
    },
    onError: (error) => {
      setConfirmReset(false);
      setStatus(normalizeError(error, "Could not reset this prompt"));
    },
  });

  const canEdit = connected && file.isSuccess;

  return (
    <>
      <Dialog
        title={relative}
        description={<span className="settings-note">{file.data?.path ?? entry.path}</span>}
        size="wide"
        onClose={onClose}
        footer={(
          <div className="skill-viewer-actions">
            {editing ? (
              <>
                <button
                  className="ghost-button"
                  data-testid="prompt-cancel"
                  onClick={() => {
                    setDraft(file.data?.content ?? file.data?.default ?? "");
                    setEditing(false);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="primary-button"
                  data-testid="prompt-save"
                  disabled={save.isPending}
                  onClick={() => save.mutate()}
                >
                  <Save size={15} /> Save
                </button>
              </>
            ) : (
              <>
                <button
                  className="ghost-button"
                  data-testid="prompt-reset"
                  disabled={!canEdit || state === "absent" || reset.isPending}
                  title={state === "absent" ? "No user copy to reset" : "Restore the shipped prompt"}
                  onClick={() => setConfirmReset(true)}
                >
                  <RotateCcw size={15} /> Reset
                </button>
                <button
                  className="primary-button"
                  data-testid="prompt-edit"
                  disabled={!canEdit}
                  onClick={() => {
                    setStatus(null);
                    setEditing(true);
                  }}
                >
                  <Pencil size={15} /> Edit
                </button>
              </>
            )}
          </div>
        )}
      >
        {file.isLoading && <LoadingState label="Loading prompt" />}
        {file.isError && (
          <EmptyState
            label="Could not read this prompt"
            detail={normalizeError(file.error, "The agent refused the read, or the file is gone.")}
          />
        )}
        {file.isSuccess && (
          <>
            <p className="settings-note" data-testid="prompt-state">
              {state === "absent"
                ? "No user copy — the shipped prompt is in use. Editing creates one."
                : state === "unmodified"
                  ? "The user copy matches the shipped prompt."
                  : "Modified — this copy overrides the shipped prompt."}
            </p>
            {editing ? (
              <textarea
                className="settings-textarea skill-prompt-editor"
                rows={18}
                value={draft}
                aria-label="Prompt text"
                data-testid="prompt-editor"
                onChange={(event) => setDraft(event.target.value)}
              />
            ) : (
              <pre className="settings-textarea skill-prompt" data-testid="prompt-text">
                {file.data?.content ?? file.data?.default ?? "(empty)"}
              </pre>
            )}
          </>
        )}
        {status && <p className="settings-note" data-testid="prompt-status">{status}</p>}
      </Dialog>
      {confirmReset && (
        <ConfirmDialog
          title="Reset this prompt?"
          description={`Discard your copy of ${relative} and restore the shipped prompt.`}
          confirmLabel="Reset"
          danger
          busy={reset.isPending}
          confirmTestId="prompt-reset-confirm"
          onCancel={() => setConfirmReset(false)}
          onConfirm={() => reset.mutate()}
        />
      )}
    </>
  );
}
