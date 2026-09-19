import type { InitializeResponse } from "@agentclientprotocol/sdk";
import { useCatalogStore } from "../../state/catalog";
import { buildInitializeRequest } from "../handshake";
import { request } from "../host";
import { commandsFromUpdate } from "../xai";
import { isRecord } from "./wire";

/**
 * Store `cancelRewind` / `sessionRecap` from initialize meta. Matches the pager:
 * cancelRewind defaults on when absent; sessionRecap is fail-closed (off until advertised).
 */
export function applyInitializeFeatureGates(response: InitializeResponse): void {
  const meta = (response as { _meta?: unknown; meta?: unknown })._meta
    ?? (response as { meta?: unknown }).meta;
  if (!isRecord(meta)) return;
  const cancelRewind = meta.cancelRewind;
  const sessionRecap = meta.sessionRecap;
  useCatalogStore.getState().setFeatureGates({
    ...(typeof cancelRewind === "boolean" ? { cancelRewindEnabled: cancelRewind } : {}),
    ...(typeof sessionRecap === "boolean" ? { sessionRecapEnabled: sessionRecap } : {}),
  });
  // Seed slash catalog before the first `commands/list` / ACU (P10).
  if (Array.isArray(meta.availableCommands) && meta.availableCommands.length > 0) {
    useCatalogStore.getState().setCommands(commandsFromUpdate(meta.availableCommands));
  }
}

/** The `initialize` handshake every process start runs before any other request. */
export async function initializeHandshake(): Promise<void> {
  const response = await request<InitializeResponse>(
    "initialize",
    buildInitializeRequest(__APP_VERSION__),
  );
  // P5 / P10: feature gates from InitializeResponse.meta (cancelRewind, sessionRecap).
  // Keep this parse minimal — another agent may own the rest of loadSession meta.
  applyInitializeFeatureGates(response);
}
