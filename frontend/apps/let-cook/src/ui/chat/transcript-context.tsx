import { createContext, useContext } from "react";

export interface TranscriptActions {
  enableFollow: () => void;
  pageScroll: (direction: "up" | "down") => void;
}

const noopActions: TranscriptActions = {
  enableFollow: () => undefined,
  pageScroll: () => undefined,
};

export const TranscriptActionsContext = createContext<TranscriptActions>(noopActions);

export function useTranscriptActions(): TranscriptActions {
  return useContext(TranscriptActionsContext);
}
