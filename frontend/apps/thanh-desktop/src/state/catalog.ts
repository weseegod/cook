import { create } from "zustand";
import type { McpServerView } from "../acp/extensions";
import type { CommandSummary, ModelSummary, SessionSummary } from "../acp/xai";
import { useSessionStore } from "./session";

interface CatalogState {
  sessions: SessionSummary[];
  models: ModelSummary[];
  /** The model the agent would use right now; the picker's value before the first session. */
  currentModelId: string | null;
  commands: CommandSummary[];
  /** MCP connectors; kept fresh by N-mcp-* notifications (C3). */
  mcpServers: McpServerView[];
  sessionSearch: string;
  setSessions: (sessions: SessionSummary[]) => void;
  setModelCatalog: (catalog: { currentModelId: string | null; models: ModelSummary[] }) => void;
  setCommands: (commands: CommandSummary[]) => void;
  setMcpServers: (mcpServers: McpServerView[]) => void;
  setSessionSearch: (sessionSearch: string) => void;
}

export const useCatalogStore = create<CatalogState>((set) => ({
  sessions: [],
  models: [],
  currentModelId: null,
  commands: [],
  mcpServers: [],
  sessionSearch: "",
  setSessions: (sessions) => set({ sessions }),
  setModelCatalog: ({ currentModelId, models }) => set({ currentModelId, models }),
  setCommands: (commands) => set({ commands }),
  setMcpServers: (mcpServers) => set({ mcpServers }),
  setSessionSearch: (sessionSearch) => set({ sessionSearch }),
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
