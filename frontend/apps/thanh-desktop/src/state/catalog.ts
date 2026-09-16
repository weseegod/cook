import { create } from "zustand";
import type { CommandSummary, ModelSummary, SessionSummary } from "../acp/xai";

interface CatalogState {
  sessions: SessionSummary[];
  models: ModelSummary[];
  commands: CommandSummary[];
  sessionSearch: string;
  setSessions: (sessions: SessionSummary[]) => void;
  setModels: (models: ModelSummary[]) => void;
  setCommands: (commands: CommandSummary[]) => void;
  setSessionSearch: (sessionSearch: string) => void;
}

export const useCatalogStore = create<CatalogState>((set) => ({
  sessions: [],
  models: [],
  commands: [],
  sessionSearch: "",
  setSessions: (sessions) => set({ sessions }),
  setModels: (models) => set({ models }),
  setCommands: (commands) => set({ commands }),
  setSessionSearch: (sessionSearch) => set({ sessionSearch }),
}));
