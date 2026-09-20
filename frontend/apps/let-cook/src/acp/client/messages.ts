import type { SessionNotification } from "@agentclientprotocol/sdk";
import { useCatalogStore } from "../../state/catalog";
import { useSessionStore } from "../../state/session";
import { SessionNotificationCoalescer } from "../client-coalesce";
import type { RpcMessage } from "../host";
import { dispatchNotification } from "../notifications";
import { dispatchReverseRequest } from "../reverse";
import type { PromptCorrelation, SessionEventDedupe } from "../session-events";
import { commandsFromUpdate } from "../xai";
import { noteBackgroundActivity, routeChildUpdate, shouldApplyToActiveSession } from "./state";
import { planModeIsOn, unwrapMethod, unwrapParams } from "./wire";

/** The live client's ordering state, read and driven by the inbound message pipeline. */
export interface InboundPipeline {
  readonly promptCorrelation: PromptCorrelation;
  readonly sessionEvents: SessionEventDedupe;
  readonly sessionUpdates: SessionNotificationCoalescer;
  readonly refreshPlanFiles: () => void;
  readonly refreshModels: () => Promise<void>;
}

// The store is frame-coalesced, so two goal updates in one wire batch cannot reliably compare
// against store state. Track the transient planning latch at the inbound boundary instead.
const goalPlanningByPipeline = new WeakMap<InboundPipeline, boolean>();

export async function handleInboundMessages(pipeline: InboundPipeline, messages: RpcMessage[]) {
  for (const message of messages) {
    const method = unwrapMethod(message);
    const params = unwrapParams(message);
    // Both envelopes carry `{ sessionId, update }`. The extension ones (`x.ai/session_notification`,
    // `x.ai/session/update`) are how the shell ships what ACP has no slot for — goal orchestration above all.
    if (
      method === "session/update"
      || method === "x.ai/session_notification"
      || method === "x.ai/session/update"
    ) {
      if (!pipeline.promptCorrelation.accept(params)) continue;
      const rail: "acp" | "xai" = method === "session/update" ? "acp" : "xai";
      if (!pipeline.sessionEvents.accept(rail, params)) continue;
      const update = params.update as Record<string, unknown> | undefined;
      if (update?.sessionUpdate === "available_commands_update") {
        useCatalogStore.getState().setCommands(commandsFromUpdate(update.availableCommands));
      }
      // P6–P8: catalog/settings notifs arrive as sessionUpdate tags (U-memf / U-plug / U-hook*).
      const sessionKind = typeof update?.sessionUpdate === "string" ? update.sessionUpdate : "";
      if (
        sessionKind === "memory_files"
        || sessionKind === "plugins_changed"
        || sessionKind === "hooks_changed"
        || sessionKind === "hook_annotation"
        || sessionKind === "hook_run_started"
        || sessionKind === "hook_execution"
      ) {
        await dispatchNotification(message, sessionKind, update ?? {});
      }
      // `PlanModeEntered` arrives as a mode update, and it is the moment the episode's plan file
      // appears (`enter_plan_mode` rotates the file before seeding it); list again so the header
      // shows the new episode.
      if (sessionKind === "current_mode_update" && planModeIsOn(update)) {
        pipeline.refreshPlanFiles();
      }
      if (shouldApplyToActiveSession(params, update)) {
        if (sessionKind === "goal_updated") {
          const previous = goalPlanningByPipeline.get(pipeline)
            ?? useSessionStore.getState().goal?.planning
            ?? false;
          const next = update?.planning === true;
          const goalCreated = update?.last_event === "goal_created";
          if ((previous && !next) || goalCreated) pipeline.refreshPlanFiles();
          goalPlanningByPipeline.set(pipeline, next);
        }
        pipeline.sessionUpdates.enqueue(params as unknown as SessionNotification);
      } else {
        // A child's first update can share a packet batch with its spawn, which the coalescer is
        // still holding: apply what is pending so the row exists before the update is routed.
        pipeline.sessionUpdates.flushNow();
        routeChildUpdate(params, update);
        noteBackgroundActivity(params, update);
      }
      continue;
    }
    // Non-session messages can affect prompt completion, so do not let a deferred update pass
    // them in the wire order.
    pipeline.sessionUpdates.flushNow();
    if (method === "x.ai/session/prompt_complete" && !pipeline.promptCorrelation.accept(params)) continue;
    await handleMessage(pipeline, message, method, params);
  }
}

async function handleMessage(
  pipeline: InboundPipeline,
  message: RpcMessage,
  method = unwrapMethod(message),
  params = unwrapParams(message),
) {
  if (!method) return;

  // Layer 2 — reverse requests (message has id).
  if (message.id !== undefined) {
    await dispatchReverseRequest(message, method, params);
    // A parked review means the episode's plan file exists, even when the mode update that would
    // otherwise reveal it was missed (a session loaded mid-plan, for instance).
    if (method === "x.ai/exit_plan_mode") pipeline.refreshPlanFiles();
    return;
  }

  // Layer 3 — notifications.
  await dispatchNotification(message, method, params, {
    refreshModels: pipeline.refreshModels,
  });
}
