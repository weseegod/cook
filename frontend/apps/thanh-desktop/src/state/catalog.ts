import { create } from "zustand";
import type { McpServerView, PluginView } from "../acp/extensions";
import type { HookEventLogEntry, HookView, MemoryFileView } from "../acp/settings-ext";
import type { CommandSummary, ModelSummary, SessionSummary } from "../acp/xai";
import { useSessionStore } from "./session";

const MAX_HOOK_EVENTS = 80;

interface CatalogState {
  sessions: SessionSummary[];
  models: ModelSummary[];
  /** The model the agent would use right now; the picker's value before the first session. */
  currentModelId: string | null;
  commands: CommandSummary[];
  /** MCP connectors; kept fresh by N-mcp-* notifications (C3). */
  mcpServers: McpServerView[];
  /** Memory file list from U-memf (`memory_files` session update). */
  memoryFiles: MemoryFileView[];
  memoryEnabled: boolean;
  /** Plugins snapshot from U-plug (`plugins_changed`). */
  plugins: PluginView[];
  /** Hooks snapshot from U-hook* (`hooks_changed`) or list. */
  hooks: HookView[];
  hooksProjectTrusted: boolean;
  /** Recent N-hookev / U-hook* log lines for Settings → Hooks. */
  hookEvents: HookEventLogEntry[];
  sessionSearch: string;
  /**
   * From `InitializeResponse.meta.cancelRewind` (default on). Gates `/rewind` UI when
   * the shell has rolled the feature off.
   */
  cancelRewindEnabled: boolean;
  /**
   * From `InitializeResponse.meta.sessionRecap` (default off / fail-closed). Gates `/recap`
   * so a disabled rollout produces zero `x.ai/recap` traffic.
   */
  sessionRecapEnabled: boolean;
  /** Settings tab the slash/palette asked to open (`/memory` → context). */
  pendingSettingsTab: string | null;
  setSessions: (sessions: SessionSummary[]) => void;
  setModelCatalog: (catalog: { currentModelId: string | null; models: ModelSummary[] }) => void;
  setCommands: (commands: CommandSummary[]) => void;
  setMcpServers: (mcpServers: McpServerView[]) => void;
  setMemoryFiles: (files: MemoryFileView[], enabled?: boolean) => void;
  setPlugins: (plugins: PluginView[]) => void;
  setHooks: (hooks: HookView[], projectTrusted?: boolean) => void;
  appendHookEvent: (entry: Omit<HookEventLogEntry, "id" | "at"> & { id?: string; at?: number }) => void;
  setSessionSearch: (sessionSearch: string) => void;
  setFeatureGates: (gates: { cancelRewindEnabled?: boolean; sessionRecapEnabled?: boolean }) => void;
  requestSettingsTab: (tab: string) => void;
  clearPendingSettingsTab: () => void;
}

export const useCatalogStore = create<CatalogState>((set) => ({
  sessions: [],
  models: [],
  currentModelId: null,
  commands: [],
  mcpServers: [],
  memoryFiles: [],
  memoryEnabled: true,
  plugins: [],
  hooks: [],
  hooksProjectTrusted: false,
  hookEvents: [],
  sessionSearch: "",
  cancelRewindEnabled: true,
  sessionRecapEnabled: false,
  pendingSettingsTab: null,
  setSessions: (sessions) => set({ sessions }),
  setModelCatalog: ({ currentModelId, models }) => set({ currentModelId, models }),
  setCommands: (commands) => set({ commands }),
  setMcpServers: (mcpServers) => set({ mcpServers }),
  setMemoryFiles: (memoryFiles, enabled) =>
    set({ memoryFiles, ...(enabled === undefined ? {} : { memoryEnabled: enabled }) }),
  setPlugins: (plugins) => set({ plugins }),
  setHooks: (hooks, projectTrusted) =>
    set({ hooks, ...(projectTrusted === undefined ? {} : { hooksProjectTrusted: projectTrusted }) }),
  appendHookEvent: (entry) =>
    set((state) => {
      const next: HookEventLogEntry = {
        id: entry.id ?? `hook-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        at: entry.at ?? Date.now(),
        event: entry.event,
        summary: entry.summary,
      };
      return { hookEvents: [next, ...state.hookEvents].slice(0, MAX_HOOK_EVENTS) };
    }),
  setSessionSearch: (sessionSearch) => set({ sessionSearch }),
  setFeatureGates: (gates) => set(gates),
  requestSettingsTab: (tab) => set({ pendingSettingsTab: tab }),
  clearPendingSettingsTab: () => set({ pendingSettingsTab: null }),
}));

/**
 * The model both pickers show.
 *
 * The session's own model wins; before the first prompt that is the window's remembered choice,
 * which is also what `session/new` sends, so the picker never disagrees with the next session.
 * `known` is false while the catalog is empty or does not list that id, which is what the pickers
 * use to render a label for it instead of silently showing some other model.
 */
export function useModelSelection(): { id: string; known: boolean; models: ModelSummary[] } {
  const sessionModelId = useSessionStore((state) => state.modelId);
  const currentModelId = useCatalogStore((state) => state.currentModelId);
  const models = useCatalogStore((state) => state.models);
  const id = sessionModelId ?? currentModelId ?? "";
  return { id, models, known: models.some((model) => model.id === id) };
}
