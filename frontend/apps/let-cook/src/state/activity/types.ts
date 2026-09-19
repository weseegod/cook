import type { TranscriptState } from "../session";

export type ActivityKind = "task" | "subagent" | "schedule" | "workflow";

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  name: string;
  status: string;
  startedAt: number;
  endedAt?: number;
  detail?: string;
  humanSchedule?: string;
  nextFireAt?: string | null;
  isMonitor?: boolean;
  /**
   * Conversation that owns the row. `undefined` for legacy flat payloads, which belong to whatever
   * conversation is open; a stamped row from another conversation stays out of this one's list
   * (`shouldApplyToActiveSession` deliberately lets background subagents and workflows through).
   */
  sessionId?: string;
  /**
   * What the job is doing right now, as the TUI paints it after the row label
   * (`tasks_pane.rs` ` · {activity}` → `app/subagent.rs::format_activity_label`): `Thinking`,
   * `Running: cargo build`, `Wait 5 seconds…`. Running rows only.
   */
  activityLabel?: string;
  /**
   * Session the agent streams a subagent's own updates under. Child `session/update` traffic is
   * dropped from the parent transcript (`shouldApplyToActiveSession`), so this is the key that
   * routes it to the row and to the viewer instead.
   */
  childSessionId?: string;
  /** A background command's captured stdout, as `x.ai/task/list` / `task_completed` report it. */
  output?: string;
  /** Path the shell writes the full stdout to, when it outgrew the snapshot's own copy. */
  outputFile?: string;
  /** `output` is a prefix of the real thing (`TaskSnapshot::truncated`). */
  truncated?: boolean;
}

export interface ActivityState {
  tasks: Record<string, ActivityItem>;
  subagents: Record<string, ActivityItem>;
  schedules: Record<string, ActivityItem>;
  workflows: Record<string, ActivityItem>;
  /** Per-child transcript, fed by the child's own `session/update` stream. */
  childTranscripts: Record<string, TranscriptState>;
  /** Incremented when `/tasks` or `/dashboard` asks the shell to open the Activity tab. */
  panelNonce: number;
  panelTarget: "activity" | null;
  /** Whether the header's tasks strip is showing (`ToggleTasks`, Ctrl-G). */
  overlayOpen: boolean;
  /** The job whose read-only viewer is open (`tasks_pane.rs` `[view]`), or `null`. */
  viewing: ActivityItem | null;
  lastError: string | null;
  requestOpenPanel: () => void;
  clearPanelTarget: () => void;
  setOverlayOpen: (open: boolean) => void;
  toggleOverlay: () => void;
  setViewing: (item: ActivityItem) => void;
  clearViewing: () => void;
  reset: () => void;
  upsertTask: (item: ActivityItem) => void;
  completeTask: (taskId: string, patch?: Partial<ActivityItem>) => void;
  upsertSubagent: (item: ActivityItem) => void;
  upsertSchedule: (item: ActivityItem) => void;
  removeSchedule: (taskId: string) => void;
  upsertWorkflow: (item: ActivityItem) => void;
  setActivityLabel: (id: string, label: string) => void;
  setChildTranscript: (childSessionId: string, transcript: TranscriptState) => void;
  refreshFromAgent: (sessionId: string) => Promise<void>;
  killActivity: (sessionId: string, item: ActivityItem) => Promise<void>;
}

/** The maps a row list is derived from, so a component can subscribe to exactly those. */
export type ActivityRowsSource = Pick<ActivityState, "tasks" | "subagents" | "schedules" | "workflows">;
