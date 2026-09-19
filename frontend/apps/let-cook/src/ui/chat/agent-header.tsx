import { ListTodo, PanelLeftClose, PanelLeftOpen, PanelRight } from "lucide-react";
import { acpClient } from "../../acp/client";
import { pickFolder } from "../../acp/host";
import { useSessionStore } from "../../state/session";
import { ContextChip } from "./context-chip";
import { GitChip } from "./git-chip";
import { GoalStatus } from "./goal-status";
import { HeaderDiffstat } from "./header-diffstat";
import { PlanChip } from "./plan-chip";

/**
 * Agent status bar (catalog §3.3): the workspace and its plans left, chips right. One
 * `margin-left: auto` on the right cluster — no ProcessStatus, no competing auto margins. The
 * right cluster reads left to right as workspace git state — working-tree line changes, then the
 * branch chip that carries the commit commands.
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
  const hasPlanEntries = useSessionStore((state) =>
    state.blocks.some((block) => block.type === "plan" && block.entries.length > 0),
  );
  const todoOverlayOpen = useSessionStore((state) => state.todoOverlayOpen);
  const setTodoOverlayOpen = useSessionStore((state) => state.setTodoOverlayOpen);

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
      </div>
      <div className="agent-header-right">
        <HeaderDiffstat />
        <GitChip />
        {hasPlanEntries && (
          <button
            type="button"
            className={`todo-toggle${todoOverlayOpen ? " active" : ""}`}
            data-testid="todo-toggle"
            title={todoOverlayOpen ? "Hide plan checklist" : "Show plan checklist"}
            aria-label={todoOverlayOpen ? "Hide plan checklist" : "Show plan checklist"}
            aria-pressed={todoOverlayOpen}
            onClick={() => setTodoOverlayOpen(!todoOverlayOpen)}
          >
            <ListTodo size={14} />
          </button>
        )}
        <GoalStatus />
        <ContextChip />
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
    </header>
  );
}

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}
