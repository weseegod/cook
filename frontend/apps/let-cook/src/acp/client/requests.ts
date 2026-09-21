import { buildPromptParts, imageAttachEnabled, type Attachment } from "../attachments";
import { normalizeError } from "../errors";
import { CAPABILITIES } from "../handshake";
import { notify, request, respond } from "../host";
import { listPlanFiles } from "../plan-files";
import { setDefaultModel as setDefaultModelOnAgent } from "../providers";
import { reasoningEffortOptions, type SessionInfo, type XaiClient } from "../xai";
import { useCatalogStore } from "../../state/catalog";
import { useSessionStore } from "../../state/session";
import { writeLocal } from "../../ui/storage";

/** Whether the active model accepts `image` prompt parts. */
export function activeModelAcceptsImages(): boolean {
  const { modelId } = useSessionStore.getState();
  const { models, currentModelId } = useCatalogStore.getState();
  // Before the first session the active model is the one the agent reports, so the gate still holds.
  const activeId = modelId ?? currentModelId;
  const active = models.find((model) => model.id === activeId) ?? models.find((model) => model.isDefault) ?? null;
  return imageAttachEnabled(active);
}

/** Turn the composer's text + attachments into ACP content parts, surfacing rejections. */
export function composePromptParts(text: string, attachments: Attachment[]) {
  const { parts, rejected } = buildPromptParts(text, attachments, { supportsImages: activeModelAcceptsImages() });
  if (rejected.length > 0) {
    useSessionStore.getState().set({
      error: rejected.map((item) => `${item.name} was not attached: ${item.reason}`).join("; "),
    });
  }
  return parts;
}

const REASONING_EFFORT_PREFS_KEY = "reasoningEffortByModel";

function readReasoningEffortPrefs(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(`cook.${REASONING_EFFORT_PREFS_KEY}`) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

export function preferredReasoningEffort(modelId: string): string | null {
  return readReasoningEffortPrefs()[modelId] ?? null;
}

function rememberReasoningEffort(modelId: string, effort: string): void {
  const prefs = readReasoningEffortPrefs();
  prefs[modelId] = effort;
  writeLocal(REASONING_EFFORT_PREFS_KEY, JSON.stringify(prefs));
}

function effectiveReasoningEffort(modelId: string, requested?: string): string | null {
  const model = useCatalogStore.getState().models.find((entry) => entry.id === modelId);
  const options = reasoningEffortOptions(model);
  const candidate = requested ?? preferredReasoningEffort(modelId);
  return candidate && options.some((option) => option.value === candidate) ? candidate : null;
}

export async function sendModelChoice(modelId: string, requestedEffort?: string): Promise<void> {
  const effort = effectiveReasoningEffort(modelId, requestedEffort);
  const sessionId = useSessionStore.getState().sessionId;
  // Before the first prompt there is no session to switch, and there does not need to be: the
  // choice rides `session/new`'s `_meta.modelId` and is applied by the agent when it spawns.
  if (sessionId) {
    await request("session/set_model", {
      sessionId,
      modelId,
      ...(effort ? { _meta: { reasoningEffort: effort } } : {}),
    });
  }
  if (requestedEffort && effort === requestedEffort) rememberReasoningEffort(modelId, effort);
  writeLocal("defaultModel", modelId);
  const selected = useCatalogStore.getState().models.find((model) => model.id === modelId);
  useSessionStore.getState().set({ modelId, reasoningEffort: effort ?? selected?.reasoningEffort ?? null });
  const catalog = useCatalogStore.getState();
  const usage = useSessionStore.getState().usage;
  if (usage && selected?.contextWindow) {
    useSessionStore.getState().set({ usage: { ...usage, size: selected.contextWindow } });
  }
  catalog.setModelCatalog({
    currentModelId: modelId,
    models: catalog.models,
  });
}

/**
 * Persist the default through the desktop config service when available.
 *
 * Browser/legacy clients fall back to `x.ai/models/set_default`; if that is unavailable, the
 * choice still reaches the next session through `_meta.modelId`.
 */
export async function pushDefaultModel(modelId: string): Promise<void> {
  try {
    await setDefaultModelOnAgent(modelId);
  } catch (error) {
    const detail = normalizeError(error, "The request failed");
    useSessionStore.getState().set({
      notice: /-32601|method not found/i.test(detail)
        ? "This agent build cannot write [models] default, so the choice applies to this window only."
        : `${detail} — the default applies to this window only.`,
    });
  }
  await sendModelChoice(modelId);
}

export async function sendYoloMode(enabled: boolean): Promise<void> {
  writeLocal("alwaysApprove", String(enabled));
  useSessionStore.getState().set({ alwaysApprove: enabled });
  await notify("x.ai/yolo_mode_changed", {
    yolo_mode: enabled,
    clientIdentifier: CAPABILITIES.clientIdentifier,
  });
}

export async function answerPermissionRequest(optionId?: string): Promise<void> {
  const pending = useSessionStore.getState().pendingPermission;
  if (!pending) return;
  await respond(
    pending.rpcId,
    optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } },
  );
  useSessionStore.getState().set({ pendingPermission: null });
}

export async function answerPendingQuestion(result: unknown): Promise<void> {
  const pending = useSessionStore.getState().pendingQuestion;
  if (!pending) return;
  await respond(pending.rpcId, result);
  useSessionStore.getState().set({ pendingQuestion: null });
  if (pending.kind === "plan") useSessionStore.getState().endPlanReview();
}

/**
 * Answer a parked `x.ai/exit_plan_mode`. One path for the popup, the inline card and every key
 * binding so the payload cannot drift: only `cancelled` carries feedback
 * (`ExitPlanModeExtResponse`), and an empty one is sent as absent.
 */
export async function resolveParkedPlan(outcome: string, feedback?: string | null): Promise<void> {
  const trimmed = feedback?.trim();
  await answerPendingQuestion({
    outcome,
    ...(outcome === "cancelled" && trimmed ? { feedback: trimmed } : {}),
  });
}

/**
 * The agent's own view of the session, or `null` when there is no session yet or the agent
 * build has no such extension.
 */
export async function readSessionInfo(xai: XaiClient): Promise<SessionInfo | null> {
  const sessionId = useSessionStore.getState().sessionId;
  if (!sessionId) return null;
  try {
    return await xai.sessionInfo(sessionId);
  } catch {
    return null;
  }
}

/**
 * Feed the status bar and `/context` from `x.ai/session/info`.
 *
 * A real turn emits no ACP `usage_update`, so without this the token chip never moves. A failed
 * or silent call leaves the last known numbers in place rather than blanking them.
 */
export async function pullUsage(xai: XaiClient): Promise<void> {
  const context = (await readSessionInfo(xai))?.context;
  if (typeof context?.used !== "number") return;
  useSessionStore.getState().set({
    usage: { used: context.used, ...(typeof context.total === "number" ? { size: context.total } : {}) },
  });
}

/**
 * Feed the header's plan list from `x.ai/session/plans`.
 *
 * Agents that predate the method answer -32601; the header then keeps its older single-chip
 * behavior, so a failure here must never surface as an error.
 */
export async function pullPlanFiles(fallbackCwd: string | null): Promise<void> {
  const { sessionId, cwd } = useSessionStore.getState();
  const workspace = cwd ?? fallbackCwd;
  if (!sessionId || !workspace) return;
  try {
    useSessionStore.getState().set({ planFiles: await listPlanFiles({ sessionId, cwd: workspace }) });
  } catch {
    // Keep the last known list.
  }
}
