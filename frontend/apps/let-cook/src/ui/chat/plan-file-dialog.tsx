import { Copy, Link2 } from "lucide-react";
import { normalizeError } from "../../acp/errors";
import type { PlanFileSummary } from "../../acp/plan-files";
import { useSessionStore } from "../../state/session";
import { Dialog } from "../components/dialog";
import { copyText } from "./clipboard";
import { Markdown } from "./markdown";

/**
 * Read-only view of a plan file that is not the unanswered waiting review.
 *
 * The decision pane owns the pending review's file while its `exit_plan_mode` request is parked;
 * everything else — earlier plans, plans that are not that waiting episode, and the same file once
 * a decision was sent — opens here. Copy and Copy file path mirror the header chip menu so the
 * viewer can share the body or path directly.
 */
export function PlanFileDialog() {
  const file = useSessionStore((state) => state.planFileView);
  const setPlanFileView = useSessionStore((state) => state.setPlanFileView);
  if (!file) return null;
  const planFile = file;

  async function copyPlan() {
    const state = useSessionStore.getState();
    if (planFile.content === null) {
      state.set({ notice: `${planFile.name} is too large to copy from here. Open it instead.` });
      return;
    }
    try {
      await copyText(planFile.content);
      state.set({ notice: `Copied ${planFile.name}` });
    } catch (error) {
      state.set({ error: normalizeError(error, "Could not copy the plan") });
    }
  }

  async function copyPlanPath() {
    const state = useSessionStore.getState();
    try {
      await copyText(planFile.path);
      state.set({ notice: `Copied ${planFile.path}` });
    } catch (error) {
      state.set({ error: normalizeError(error, "Could not copy the path") });
    }
  }

  return (
    <Dialog
      title={planFile.name}
      description={planFile.relativePath}
      size="wide"
      onClose={() => setPlanFileView(null)}
      footer={<PlanFileActions file={planFile} onCopy={() => void copyPlan()} onCopyPath={() => void copyPlanPath()} />}
    >
      <div className="plan-file-body" data-testid="plan-file-body">
        {planFile.content === null
          ? <p className="plan-file-empty">This plan is too large to show here.</p>
          : <Markdown text={planFile.content} />}
      </div>
    </Dialog>
  );
}

function PlanFileActions({
  file,
  onCopy,
  onCopyPath,
}: {
  file: PlanFileSummary;
  onCopy: () => void;
  onCopyPath: () => void;
}) {
  return (
    <div className="plan-file-actions" data-testid="plan-file-view-actions">
      <button
        type="button"
        className="chat-action-button"
        data-testid="plan-file-view-copy"
        disabled={file.content === null}
        title={file.content === null ? `${file.name} is too large to copy from here` : `Copy ${file.name}`}
        onClick={onCopy}
      >
        <Copy size={13} />
        <span>Copy</span>
      </button>
      <button
        type="button"
        className="chat-action-button"
        data-testid="plan-file-view-copy-path"
        title={`Copy path for ${file.name}`}
        onClick={onCopyPath}
      >
        <Link2 size={13} />
        <span>Copy file path</span>
      </button>
    </div>
  );
}
