import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { normalizeError } from "../../acp/errors";
import { readProjectFile, writeProjectFile, type SkillView } from "../../acp/extensions";
import { refreshSkillBaseline } from "../../acp/settings-ext";
import { useSessionStore } from "../../state/session";
import { EmptyState, LoadingState } from "../components/async-state";
import { Dialog } from "../components/dialog";
import { skillFileTarget } from "./skill-target";

/**
 * Settings → Skills: one skill's `SKILL.md`, read through the agent filesystem, with an Edit mode
 * that writes it back.
 *
 * The agent's skill list carries paths, never bodies, so the prompt is a second read. Saving
 * converges on `~/.cook/skills/` (`skill-target.ts`); the dialog names the file it wrote, because
 * for a bundled or plugin skill that is a user copy rather than the file on screen.
 */
export function SkillViewerDialog({
  skill,
  cookHome,
  connected,
  onClose,
  onSaved,
}: {
  skill: SkillView;
  /** `<cook home>`, or undefined until the host answered. */
  cookHome: string | undefined;
  connected: boolean;
  onClose: () => void;
  /** Called after a successful write, so the caller can refetch the skill list. */
  onSaved: () => void;
}) {
  const sessionId = useSessionStore((state) => state.sessionId);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  /** What this dialog last wrote. It is the body to show when the file on `path` is no longer it. */
  const [savedText, setSavedText] = useState<string | null>(null);

  const path = skill.path?.trim() ?? "";
  const target = skillFileTarget(skill, cookHome);

  const file = useQuery({
    queryKey: ["skill-file", path, sessionId],
    queryFn: () => readProjectFile(sessionId ?? undefined, path),
    enabled: connected && Boolean(path),
    retry: 0,
  });

  // Seed the editor once per file: a later refetch (ours, or a window-focus refetch) must not
  // overwrite what the user is typing or wipe the saved path.
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!file.isSuccess || seeded.current === path) return;
    seeded.current = path;
    setDraft(file.data?.content ?? "");
  }, [file.isSuccess, file.data, path]);

  const save = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error("This skill has no file to save");
      await writeProjectFile(sessionId ?? undefined, target.path, draft);
      return target;
    },
    onSuccess: (written) => {
      setEditing(false);
      // A fork writes a copy, so the file this dialog read is no longer what it shows.
      setSavedText(draft);
      setStatus(`Saved ${written.path}`);
      // The baseline call is best-effort: it only keeps the agent's file watch in step, and a
      // build without the method (the browser mock) answers `{}`.
      void refreshSkillBaseline().catch(() => undefined);
      onSaved();
      void queryClient.invalidateQueries({ queryKey: ["skill-file"] });
    },
    onError: (error) => setStatus(normalizeError(error, "Could not save this skill")),
  });

  const canEdit = connected && file.isSuccess && Boolean(target);

  return (
    <Dialog
      title={skill.displayName ?? skill.name}
      description={<span className="skill-viewer-heading">{path || "No file on disk"}{skill.scope ? ` · ${skill.scope}` : ""}</span>}
      size="wide"
      onClose={onClose}
      footer={(
        <div className="skill-viewer-actions">
          {editing ? (
            <>
              <button
                className="ghost-button"
                data-testid="skill-cancel"
                onClick={() => {
                  setDraft(savedText ?? file.data?.content ?? "");
                  setEditing(false);
                }}
              >
                Cancel
              </button>
              <button className="primary-button" data-testid="skill-save" disabled={save.isPending} onClick={() => save.mutate()}>
                <Save size={15} /> Save
              </button>
            </>
          ) : (
            <>
              <button className="ghost-button" data-testid="skill-viewer-close" onClick={onClose}>Close</button>
              <button
                className="primary-button"
                data-testid="skill-edit"
                disabled={!canEdit}
                title={target ? `Edit ${target.path}` : "This skill has no file to edit"}
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
      {!path && <EmptyState label="No prompt file" detail="This skill was listed without a SKILL.md path." />}
      {path && file.isLoading && <LoadingState label="Loading prompt" />}
      {path && file.isError && (
        <EmptyState
          label="Could not read this prompt"
          detail={normalizeError(file.error, "The agent refused the read, or the file is gone.")}
        />
      )}
      {path && file.isSuccess && (
        <>
          {editing ? (
            <>
              <textarea
                className="settings-textarea skill-prompt-editor"
                rows={18}
                value={draft}
                aria-label="Skill prompt"
                data-testid="skill-prompt-editor"
                onChange={(event) => setDraft(event.target.value)}
              />
              {target?.fork && (
                <p className="settings-note" data-testid="skill-fork-note">
                  Saving to <code>{target.path}</code> — your copy takes priority over this one.
                </p>
              )}
            </>
          ) : (
            <pre className="settings-textarea skill-prompt" data-testid="skill-prompt">{savedText ?? (file.data.content || "(empty)")}</pre>
          )}
        </>
      )}
      {status && <p className="settings-note" data-testid="skill-save-status">{status}</p>}
    </Dialog>
  );
}
