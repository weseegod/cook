import { Minus, Plus } from "lucide-react";
import { memo } from "react";
import { useSessionStore } from "../../state/session";
import { useToolsPanelStore } from "../../state/tools-panel";
import { COMPOSER_SHOW_DIFFSTAT_KEY, useBooleanPref } from "../preferences";
import { useComposerMetricsStore } from "./composer-rails";
import { useGitStatus } from "./git-status";

/**
 * Line changes on the header, immediately left of the git chip: `+N −M` for the working tree, and
 * the way into the per-file patches — clicking opens the Tools panel on Review.
 *
 * Inside a repository the totals come from the snapshot the chip's own probe publishes, so the
 * header never runs a second `git status`. Where git cannot answer — a folder outside a repository,
 * or a host with no sidecar — they fall back to the edits the agent made during the turn, which the
 * transcript already carries and which cost no processes to count.
 */
export const HeaderDiffstat = memo(function HeaderDiffstat() {
  const [show] = useBooleanPref(COMPOSER_SHOW_DIFFSTAT_KEY);
  const cwd = useSessionStore((state) => state.cwd);
  const status = useGitStatus(cwd);
  const editsAdded = useComposerMetricsStore((state) => state.additions);
  const editsRemoved = useComposerMetricsStore((state) => state.deletions);
  const editsSource = useComposerMetricsStore((state) => state.diffSource);

  if (!show || !status) return null;
  const shown = status.isGitRepo
    ? { additions: status.additions, deletions: status.deletions, source: "git" as const }
    : editsSource === "edits"
      ? { additions: editsAdded, deletions: editsRemoved, source: "edits" as const }
      : null;
  // A clean tree and a turn that changed nothing both read as noise: no numbers, no rail.
  if (!shown || (shown.additions === 0 && shown.deletions === 0)) return null;

  const aria = `${shown.additions} lines added, ${shown.deletions} lines removed. Open the Review panel`;
  const where = shown.source === "git" ? "in the working tree" : "from this turn's edits (no git here)";
  const title = `+${shown.additions} −${shown.deletions} ${where} — click for Review`;
  return (
    <button
      type="button"
      className={`header-diffstat diffstat-${shown.source}`}
      data-testid="header-diffstat"
      aria-label={aria}
      title={title}
      onClick={() => useToolsPanelStore.getState().request("review")}
    >
      <span className="header-diffstat-add">
        <Plus size={11} aria-hidden="true" />
        <span className="header-diffstat-value">{shown.additions}</span>
      </span>
      <span className="header-diffstat-del">
        <Minus size={11} aria-hidden="true" />
        <span className="header-diffstat-value">{shown.deletions}</span>
      </span>
    </button>
  );
});
