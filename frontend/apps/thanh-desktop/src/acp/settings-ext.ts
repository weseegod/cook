/**
 * P6–P8 ACP wrappers: memory browser, skills mutate, plugins action/reload,
 * workflows list, hooks list/action. Kept separate from `extensions.ts` so P2
 * connector work can append there without merge conflict.
 */
import { request } from "./host";
import type { PluginView, SkillView } from "./extensions";

// ---------------------------------------------------------------------------
// Memory files (U-memf / MEM-ui)
// ---------------------------------------------------------------------------

export interface MemoryFileView {
  path: string;
  /** `"global"`, `"workspace"`, or `"session"`. */
  source: string;
  sizeBytes?: number;
  size_bytes?: number;
  modifiedEpochSecs?: number;
  modified_epoch_secs?: number;
  generated?: boolean;
}

export function memoryFileSize(file: MemoryFileView): number {
  return file.sizeBytes ?? file.size_bytes ?? 0;
}

// ---------------------------------------------------------------------------
// Skills mutate (C-sk-add)
// ---------------------------------------------------------------------------

export function addSkill(path: string, cwd?: string) {
  return request<{
    addedCount?: number;
    total?: number;
    path?: string;
    skills?: SkillView[];
    message?: string;
  }>("x.ai/skills/add", { path, ...(cwd ? { cwd } : {}) });
}

export function removeSkill(path: string, cwd?: string) {
  return request<{ path?: string; skills?: SkillView[]; message?: string }>("x.ai/skills/remove", {
    path,
    ...(cwd ? { cwd } : {}),
  });
}

export function resetSkills(cwd?: string) {
  return request<{ skills?: SkillView[]; message?: string }>("x.ai/skills/reset", cwd ? { cwd } : {});
}

export function skillsConfig(cwd?: string) {
  return request<{
    paths?: string[];
    ignore?: string[];
    totalSkills?: number;
    message?: string;
    skills?: SkillView[];
  }>("x.ai/skills/config", cwd ? { cwd } : {});
}

// ---------------------------------------------------------------------------
// Plugins action / reload (C-pl-act, C-pl-rel, U-plug)
// ---------------------------------------------------------------------------

/** Tagged `PluginsAction` from xai-hooks-plugins-types (snake_case `type`). */
export type PluginsAction =
  | { type: "reload" }
  | { type: "enable"; plugin_id: string }
  | { type: "disable"; plugin_id: string }
  | { type: "install"; source: string }
  | { type: "uninstall"; plugin_id: string; confirmed?: boolean }
  | { type: "update"; plugin_id?: string | null }
  | { type: "add"; path: string }
  | { type: "remove"; path: string };

export interface ActionOutcome {
  status: string;
  message: string;
  requiresReload?: boolean;
  requiresRestart?: boolean;
}

export function listPluginsForSession(sessionId: string) {
  return request<{ plugins?: PluginView[]; items?: PluginView[] }>("x.ai/plugins/list", { sessionId });
}

export function pluginsAction(sessionId: string, action: PluginsAction) {
  return request<ActionOutcome>("x.ai/plugins/action", { sessionId, action });
}

export function reloadPlugins() {
  return request<{ ok?: boolean }>("x.ai/plugins/reload", {});
}

// ---------------------------------------------------------------------------
// Workflows (C-wf-list)
// ---------------------------------------------------------------------------

export interface WorkflowView {
  name: string;
  description?: string;
  when_to_use?: string;
  whenToUse?: string;
  source?: string;
  path?: string;
}

export function listWorkflows(sessionId: string) {
  return request<{ workflows?: WorkflowView[] }>("x.ai/workflows/list", { sessionId });
}

// ---------------------------------------------------------------------------
// Hooks (C-hk-list, C-hk-act, N-hookev)
// ---------------------------------------------------------------------------

export interface HookView {
  name: string;
  event: string;
  handlerType?: string;
  handler_type?: string;
  matcher?: string | null;
  command?: string | null;
  url?: string | null;
  timeoutMs?: number;
  timeout_ms?: number;
  sourceDir?: string;
  source_dir?: string;
  disabled?: boolean;
  pinned?: boolean;
  removable?: boolean;
}

export interface HooksListResponse {
  hooks: HookView[];
  projectTrusted?: boolean;
  project_trusted?: boolean;
  loadErrors?: string[];
  load_errors?: string[];
}

/** Tagged `HooksAction` from xai-hooks-plugins-types (snake_case `type`). */
export type HooksAction =
  | { type: "reload" }
  | { type: "trust" }
  | { type: "untrust" }
  | { type: "enable"; hook_name: string }
  | { type: "disable"; hook_name: string }
  | { type: "add"; path: string }
  | { type: "remove"; path: string }
  | { type: "toggle_source"; hook_names: string[]; disable: boolean };

export function listHooks(sessionId: string) {
  return request<HooksListResponse>("x.ai/hooks/list", { sessionId });
}

export function hooksAction(sessionId: string, action: HooksAction) {
  return request<ActionOutcome>("x.ai/hooks/action", { sessionId, action });
}

export interface HookEventLogEntry {
  id: string;
  at: number;
  event: string;
  summary: string;
}
