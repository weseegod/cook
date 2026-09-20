import { acpClient } from "../../../acp/client";
import { useActivityStore } from "../../../state/activity";
import { useCatalogStore } from "../../../state/catalog";
import { useSessionStore } from "../../../state/session";
import { downloadMarkdown, exportFilename, exportTranscriptMarkdown } from "../export-transcript";
import type { SlashCommandHost } from "../slash-commands";
import { viewPlan } from "../view-plan";
import { openRecap } from "../view-recap";
import { openRewind } from "../view-rewind";

/** The window's own half of the slash commands; the agent's half arrives as an ordinary prompt. */
export const SLASH_HOST: SlashCommandHost = {
  setPlanMode: (enabled) => acpClient.setPlanMode(enabled),
  setModel: (modelId) => acpClient.setModel(modelId),
  setYolo: (enabled) => acpClient.setYolo(enabled),
  newSession: async () => {
    await acpClient.newSession();
  },
  forkSession: () => acpClient.forkSession(),
  exportTranscript: async () => {
    const store = useSessionStore.getState();
    const markdown = exportTranscriptMarkdown(store.blocks);
    if (!markdown) throw new Error("Nothing to export yet.");
    downloadMarkdown(exportFilename(store.sessionTitle, store.sessionId), markdown);
  },
  sendPrompt: (text) => acpClient.prompt(text),
  sessionInfo: () => acpClient.sessionInfo(),
  openPlan: () => {
    viewPlan();
  },
  openActivity: () => {
    useActivityStore.getState().requestOpenPanel();
  },
  openMemory: () => {
    useCatalogStore.getState().requestSettingsTab("context");
  },
  openRewind: () => {
    openRewind();
  },
  openRecap: () => openRecap(),
};
