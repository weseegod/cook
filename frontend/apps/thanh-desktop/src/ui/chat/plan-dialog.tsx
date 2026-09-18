import { Minus } from "lucide-react";
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
import { copyText } from "./clipboard";
import { PlanChecklist } from "./plan-list";
import { PlanLines } from "./plan-lines";

/**
 * The plan review pane. It is deliberately mounted inside `.chat-main`, so it can cover only the
 * transcript while the live prompt remains the one shared input for revision notes and comments.
 */
export function PlanDialog() {
  const review = useSessionStore((state) => state.planReview);
  const comments = useSessionStore((state) => state.planComments);
  const open = useSessionStore((state) => state.planDialogOpen);
  const planFocus = useSessionStore((state) => state.planFocus);
  const selection = useSessionStore((state) => state.planCommentRange);
  const setOpen = useSessionStore((state) => state.setPlanDialogOpen);
  const setPlanFocus = useSessionStore((state) => state.setPlanFocus);
  const setPlanCommentRange = useSessionStore((state) => state.setPlanCommentRange);
  const beginPlanComment = useSessionStore((state) => state.beginPlanComment);
  const cancelPlanComment = useSessionStore((state) => state.cancelPlanComment);
  const removeComment = useSessionStore((state) => state.removePlanComment);
  const blocks = useSessionStore((state) => state.blocks);

  const [dragAnchor, setDragAnchor] = useState<number | null>(null);
  const [activeCommentId, setActiveCommentId] = useState<number | null>(null);

  const body = review && !planBodyIsEmpty(review.body) ? review.body : null;
  const bodyText = body ?? EMPTY_PLAN_BODY;
  const lines = useMemo(() => planBodyLines(bodyText), [bodyText]);
  const planEntries = useMemo(() => {
    const plan = [...blocks].reverse().find((block): block is PlanBlock => block.type === "plan");
    return plan?.entries ?? [];
  }, [blocks]);
  const bar = planDecisionBar(review, comments.length);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (planFocus === "commenting") {
          cancelPlanComment();
        } else if (planFocus === "prompt") {
          setPlanFocus("preview");
        } else {
          setOpen(false);
        }
        if (target instanceof HTMLElement) target.blur();
        return;
      }

      if (typing) {
        // In prompt focus the empty `a`/`g` bindings still approve/run-as-goal. Once text exists,
        // the same keys belong to the shared composer and are ordinary characters.
        if (planFocus === "prompt" && useSessionStore.getState().composerDraft.trim() === "") {
          const decision = event.key === "a" ? "approve" : event.key === "g" ? "goal" : null;
          if (decision) {
            event.preventDefault();
            event.stopPropagation();
            void choose(decision);
          }
        }
        return;
      }

      if (planFocus === "preview" && event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        setPlanFocus("prompt");
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
        beginPlanComment(comment.lineRange, comment.id);
        return;
      }
      if (event.key === "x" && activeCommentId !== null) {
        event.preventDefault();
        event.stopPropagation();
        removeComment(activeCommentId);
        setActiveCommentId(null);
        setPlanCommentRange(null);
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
      beginPlanComment(selection ?? [1, 2]);
      return;
    }
    if (id === "changes") {
      setPlanFocus("prompt");
      return;
    }
    if (id === "send") {
      // Once a review is answered, comments can be sent as an ordinary prompt from the pane.
      await acpClient.prompt(planFeedback(comments, "", body));
      setOpen(false);
      return;
    }
    await acpClient.resolvePlan(PLAN_OUTCOMES[id] ?? id, null);
    setOpen(false);
  }

  function selectLine(line: number, extend: boolean) {
    if (extend && dragAnchor !== null) {
      setPlanCommentRange([Math.min(dragAnchor, line), Math.max(dragAnchor, line) + 1]);
      return;
    }
    setDragAnchor(line);
    setPlanCommentRange([line, line + 1]);
    setActiveCommentId(null);
  }

  function hoverLine(line: number) {
    if (dragAnchor === null) return;
    setPlanCommentRange([Math.min(dragAnchor, line), Math.max(dragAnchor, line) + 1]);
  }

  function commitSelection(range: [number, number] | null) {
    if (range === null || dragAnchor === null) return;
    setDragAnchor(null);
    beginPlanComment(range);
  }

  return (
    <section className="plan-pane" data-testid="plan-pane">
      <header className="plan-pane-header">
        <div className="plan-pane-heading">
          <span className="plan-pane-eyebrow">Plan review</span>
          <h2>{planDialogTitle(review)}</h2>
        </div>
        <button
          type="button"
          className="icon-button plan-pane-hide"
          aria-label="Hide plan"
          data-testid="dialog-hide"
          onClick={() => setOpen(false)}
        >
          <Minus size={17} />
        </button>
      </header>
      <div className="plan-pane-body">
        <PlanLines
          lines={lines}
          comments={comments}
          selectedRange={selection}
          activeCommentId={activeCommentId}
          onSelectLine={selectLine}
          onHoverLine={hoverLine}
          onCommitSelection={commitSelection}
          onSelectComment={(id) => {
            const comment = comments.find((item) => item.id === id);
            setActiveCommentId(id);
            setPlanCommentRange(comment?.lineRange ?? null);
          }}
        />
        {planBodyIsEmpty(review.body) && planEntries.length > 0 && (
          <section className="plan-dialog-progress">
            <h3>Progress</h3>
            <PlanChecklist entries={planEntries} />
          </section>
        )}
      </div>
      <div className="plan-bar" data-testid="plan-bar">
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
      </div>
    </section>
  );
}
