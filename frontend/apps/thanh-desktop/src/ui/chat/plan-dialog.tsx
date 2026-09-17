import { useEffect, useMemo, useState } from "react";
import { acpClient } from "../../acp/client";
import {
  EMPTY_PLAN_BODY,
  PLAN_OUTCOMES,
  planBodyIsEmpty,
  planBodyLines,
  planCommentBadge,
  planDecisionBar,
  planDialogTitle,
  planFeedback,
  type PlanDecisionId,
} from "../../state/plan-review";
import { useSessionStore, type PlanBlock } from "../../state/session";
import { Dialog } from "../components/dialog";
import { copyText } from "./clipboard";
import { PlanChecklist } from "./plan-list";
import { PlanLines } from "./plan-lines";

type PlanFocus = "preview" | "notes" | "comment";

/**
 * The plan review popup (`views/file_search/line_viewer.rs` in its `PlanPreview` kind, driven by
 * `views/plan_approval_view.rs`).
 *
 * Two things are deliberately unlike a normal dialog:
 * - the decision bar is a footer outside the scroll container, so it stays put while a long plan
 *   scrolls, and
 * - hiding is not a verdict. The minimize control only closes the surface; a parked
 *   `x.ai/exit_plan_mode` stays parked and the header chip reopens it, which is how the TUI behaves
 *   (its `[✗]` is omitted while a review is parked for exactly this reason).
 */
export function PlanDialog() {
  const review = useSessionStore((state) => state.planReview);
  const comments = useSessionStore((state) => state.planComments);
  const open = useSessionStore((state) => state.planDialogOpen);
  const setOpen = useSessionStore((state) => state.setPlanDialogOpen);
  const saveComment = useSessionStore((state) => state.savePlanComment);
  const removeComment = useSessionStore((state) => state.removePlanComment);
  const blocks = useSessionStore((state) => state.blocks);

  const [focus, setFocus] = useState<PlanFocus>("preview");
  const [notes, setNotes] = useState("");
  const [selection, setSelection] = useState<[number, number] | null>(null);
  const [dragAnchor, setDragAnchor] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [activeCommentId, setActiveCommentId] = useState<number | null>(null);

  const body = review && !planBodyIsEmpty(review.body) ? review.body : null;
  const bodyText = body ?? EMPTY_PLAN_BODY;
  const lines = useMemo(() => planBodyLines(bodyText), [bodyText]);
  const planEntries = useMemo(() => {
    const plan = [...blocks].reverse().find((block): block is PlanBlock => block.type === "plan");
    return plan?.entries ?? [];
  }, [blocks]);

  // A fresh review owns a fresh surface: the composer and any in-progress comment start clean.
  useEffect(() => {
    setFocus("preview");
    setNotes("");
    setDraft("");
    setEditingId(null);
    setActiveCommentId(null);
    setSelection(null);
    setDragAnchor(null);
  }, [review?.pending, review?.body]);

  const bar = planDecisionBar(review, comments.length);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;
      if (event.key === "Escape") {
        // Leaving the notes or a comment returns to the plan; Esc in the plan hides the surface,
        // which the Dialog shell handles.
        if (focus === "preview") return;
        event.preventDefault();
        event.stopPropagation();
        setFocus("preview");
        setEditingId(null);
        setDraft("");
        return;
      }
      if (typing) {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          if (focus === "notes") void requestChanges();
          else void commitComment();
          return;
        }
        // `a` approves from an empty notes box, and types the letter once there is text to keep
        // (`plan.rs`: `a_on_empty_revise_prompt_approves`, `a_with_nonempty_freeform_types_letter`).
        if (event.key === "a" && focus === "notes" && notes.trim() === "") {
          event.preventDefault();
          event.stopPropagation();
          void choose("approve");
        }
        return;
      }
      const decision = bar.find((item) => item.key === event.key);
      if (decision) {
        event.preventDefault();
        event.stopPropagation();
        void choose(decision.id);
        return;
      }
      if (event.key === "Enter" && activeCommentId !== null) {
        const comment = comments.find((item) => item.id === activeCommentId);
        if (!comment) return;
        event.preventDefault();
        event.stopPropagation();
        setEditingId(comment.id);
        setSelection(comment.lineRange);
        setDraft(comment.text);
        setFocus("comment");
        return;
      }
      if (event.key === "x" && activeCommentId !== null) {
        event.preventDefault();
        event.stopPropagation();
        removeComment(activeCommentId);
        setActiveCommentId(null);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  });

  if (!open || !review) return null;

  async function choose(id: PlanDecisionId) {
    if (id === "copy") {
      await copyText(bodyText);
      return;
    }
    if (id === "comment") {
      setEditingId(null);
      setDraft("");
      setSelection(selection ?? [1, 2]);
      setFocus("comment");
      return;
    }
    if (id === "changes") {
      setFocus("notes");
      return;
    }
    if (id === "send") {
      // No review is parked, so the TUI's casual `s send` posts the comments as a normal prompt.
      await acpClient.prompt(planFeedback(comments, notes, body));
      setNotes("");
      setOpen(false);
      return;
    }
    // A verdict takes the surface with it: `finish_plan_review_ui` drops the line viewer, and the
    // plan stays reachable from the chip afterwards.
    await acpClient.resolvePlan(PLAN_OUTCOMES[id] ?? id, null);
    setOpen(false);
  }

  async function requestChanges() {
    await acpClient.resolvePlan("cancelled", planFeedback(comments, notes, body));
    setOpen(false);
  }

  async function commitComment() {
    if (draft.trim() === "" || selection === null) {
      setFocus("preview");
      return;
    }
    saveComment(editingId, selection, draft);
    setDraft("");
    setEditingId(null);
    setFocus("preview");
  }

  function selectLine(line: number, extend: boolean) {
    if (extend && dragAnchor !== null) {
      setSelection([Math.min(dragAnchor, line), Math.max(dragAnchor, line) + 1]);
      return;
    }
    setDragAnchor(line);
    setSelection([line, line + 1]);
    setActiveCommentId(null);
  }

  function hoverLine(line: number) {
    if (dragAnchor === null) return;
    setSelection([Math.min(dragAnchor, line), Math.max(dragAnchor, line) + 1]);
  }

  function commitSelection(range: [number, number] | null) {
    if (range === null || dragAnchor === null) return;
    setDragAnchor(null);
    // A drag opens a range comment; a plain click opens a one-line comment, as in the TUI.
    setEditingId(null);
    setDraft("");
    setFocus("comment");
  }

  return (
    <Dialog
      title={planDialogTitle(review)}
      size="plan"
      closeKind="hide"
      closeLabel="Hide plan"
      onClose={() => setOpen(false)}
      footer={(
        <div className="plan-bar" data-testid="plan-bar">
          {focus === "preview" ? (
            <div className="plan-bar-row">
              {bar.map((item, index) => (
                <span key={item.id} className={`plan-bar-item${item.id === "copy" ? " plan-bar-copy" : ""}`}>
                  {index > 0 && <span className="plan-bar-sep" aria-hidden="true">|</span>}
                  <button
                    type="button"
                    className={`plan-bar-button plan-bar-${item.id}`}
                    data-testid={`plan-${item.id}`}
                    onClick={() => void choose(item.id)}
                  >
                    <kbd>{item.key}</kbd>
                    <span>{item.label}</span>
                  </button>
                  {item.id === "comment" && comments.length > 0 && (
                    <span className="plan-bar-badge" data-testid="plan-comment-badge">{planCommentBadge(comments.length)}</span>
                  )}
                </span>
              ))}
            </div>
          ) : (
            <div className="plan-bar-row">
              <textarea
                autoFocus
                data-testid={focus === "notes" ? "plan-notes" : "plan-comment-input"}
                className="plan-bar-input"
                rows={2}
                value={focus === "notes" ? notes : draft}
                placeholder={focus === "notes" ? "Describe the changes you want…" : "Comment on these lines…"}
                onChange={(event) => (focus === "notes" ? setNotes(event.target.value) : setDraft(event.target.value))}
              />
              <div className="plan-bar-actions">
                <span className="plan-bar-hint">
                  {focus === "notes"
                    ? (notes.trim() ? "Enter request changes" : "Enter request changes · a approve")
                    : "Enter save comment"}
                  {" · Esc back"}
                </span>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => {
                    setFocus("preview");
                    setEditingId(null);
                    setDraft("");
                  }}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="primary-button"
                  data-testid={focus === "notes" ? "plan-send-changes" : "plan-save-comment"}
                  onClick={() => void (focus === "notes" ? requestChanges() : commitComment())}
                >
                  {focus === "notes" ? "Request changes" : "Save comment"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    >
      <PlanLines
        lines={lines}
        comments={comments}
        selectedRange={selection}
        activeCommentId={activeCommentId}
        onSelectLine={selectLine}
        onHoverLine={hoverLine}
        onCommitSelection={commitSelection}
        onSelectComment={(id) => {
          setActiveCommentId(id);
          setSelection(null);
        }}
      />
      {planBodyIsEmpty(review.body) && planEntries.length > 0 && (
        <section className="plan-dialog-progress">
          <h3>Progress</h3>
          <PlanChecklist entries={planEntries} />
        </section>
      )}
    </Dialog>
  );
}
