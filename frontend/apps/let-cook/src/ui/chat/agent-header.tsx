import { PanelLeftClose, PanelLeftOpen, PanelRight } from "lucide-react";
import { useEffect } from "react";
import { acpClient } from "../../acp/client";
import { pickFolder } from "../../acp/host";
import { useSessionStore } from "../../state/session";
import { TasksChip } from "../activity/tasks-chip";
import { GitChip } from "./git-chip";
import { GoalStatus } from "./goal-status";
import { HeaderDiffstat } from "./header-diffstat";
import { PlanChip } from "./plan-chip";
import { TodoChip } from "./todo-chip";

/**
 * Agent status bar (catalog §3.3): the workspace and its plans left, chips right. One
 * `margin-left: auto` on the right cluster — no ProcessStatus, no competing auto margins. The
 * right cluster uses fixed slots so optional status chips can appear without moving a neighbor:
 * goal (or the plan checklist when there is no goal), line changes, Git, then tools.
 */
export function AgentHeader({
  sidebarOpen,
  onToggleSidebar,
  utilityPanelOpen,
  onOpenTools,
}: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  utilityPanelOpen: boolean;
  onOpenTools: () => void;
}) {
  const cwd = useSessionStore((state) => state.cwd);
  const goal = useSessionStore((state) => state.goal);
  const hasChecklist = useSessionStore((state) => state.planEntries.length > 0);
  const setTodoOverlayOpen = useSessionStore((state) => state.setTodoOverlayOpen);
  const hasGoal = goal !== null;

  useEffect(() => {
    if (hasGoal) setTodoOverlayOpen(false);
  }, [hasGoal, setTodoOverlayOpen]);

  async function chooseWorkspace() {
    const selected = await pickFolder();
    if (selected && selected !== cwd) await acpClient.connect(selected);
  }

  const cwdLabel = cwd ? shortPath(cwd) : "Choose folder";

  return (
    <header className="agent-header" data-testid="agent-header">
      <div className="agent-header-left">
        <button className="icon-button" onClick={onToggleSidebar} aria-label="Toggle sessions">
          {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
        </button>
        <button
          type="button"
          className="agent-cwd"
          onClick={() => void chooseWorkspace()}
          title={cwd ?? "Choose a workspace folder"}
          aria-label="Choose workspace folder"
        >
          <span>{cwdLabel}</span>
        </button>
        <PlanChip />
        <TasksChip />
      </div>
      <div className="agent-header-right">
        <div className={`agent-header-slot agent-header-slot-goal${hasGoal ? "" : hasChecklist ? " agent-header-slot-goal-checklist" : " agent-header-slot-goal-empty"}`}>
          {hasGoal ? <GoalStatus /> : <TodoChip />}
        </div>
        <div className="agent-header-slot agent-header-slot-diffstat">
          <HeaderDiffstat />
        </div>
        <div className="agent-header-slot agent-header-slot-git">
          <GitChip />
        </div>
        <div className="agent-header-slot agent-header-slot-tools">
          {cwd && !utilityPanelOpen && (
            <button
              className="icon-button"
              onClick={onOpenTools}
              aria-label="Open tools panel"
              title="Open tools panel"
            >
              <PanelRight size={17} />
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}
