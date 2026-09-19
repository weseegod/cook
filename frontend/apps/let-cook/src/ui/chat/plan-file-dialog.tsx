import { useSessionStore } from "../../state/session";
import { Dialog } from "../components/dialog";
import { Markdown } from "./markdown";

/**
 * Read-only view of one plan file from the session's history.
 *
 * The review pane owns the current episode, because that is the one with a decision attached;
 * `x.ai/exit_plan_mode` carries the body, so an earlier or an already-answered plan is read back
 * from the list response instead.
 */
export function PlanFileDialog() {
  const file = useSessionStore((state) => state.planFileView);
  const setPlanFileView = useSessionStore((state) => state.setPlanFileView);
  if (!file) return null;
  return (
    <Dialog
      title={file.name}
      description={file.relativePath}
      size="wide"
      onClose={() => setPlanFileView(null)}
    >
      <div className="plan-file-body" data-testid="plan-file-body">
        {file.content === null
          ? <p className="plan-file-empty">This plan is too large to show here.</p>
          : <Markdown text={file.content} />}
      </div>
    </Dialog>
  );
}
