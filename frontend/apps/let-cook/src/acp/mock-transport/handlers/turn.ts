import { notify, state } from "../state";
import type { MethodHandler } from "./registry";

const emptyResponse: MethodHandler = ({ respond }) => {
    return respond({});
};

export const turnHandlers: Record<string, MethodHandler> = {
  "x.ai/rewind/points": ({ respond }) => {
    return respond({
      result: {
        rewindPoints: state.rewindPoints.map((point) => ({
          promptIndex: point.promptIndex,
          createdAt: point.createdAt,
          numFileSnapshots: point.numFileSnapshots,
          hasFileChanges: point.hasFileChanges === true,
          promptPreview: point.promptPreview ?? null,
        })),
      },
    });
  },
  "x.ai/rewind/execute": ({ p, respond }) => {
    const target = Number(p.targetPromptIndex ?? p.target_prompt_index);
    if (!Number.isFinite(target)) {
      return respond({ result: { success: false, target_prompt_index: 0, error: "targetPromptIndex required" } });
    }
    return respond({
      result: {
        success: true,
        target_prompt_index: target,
        mode: "all",
        reverted_files: [],
        clean_files: [],
        conflicts: [],
      },
    });
  },
  "x.ai/recap": ({ p, sessionId, respond }) => {
    if (!state.sessionRecap) return respond({ result: { ok: true, disabled: true } });
    // Fire-and-forget: the summary (or unavailable) arrives as a session_notification.
    queueMicrotask(() => {
      if (state.recapSummary) {
        notify("_x.ai/session_notification", {
          sessionId,
          update: { sessionUpdate: "session_recap", summary: state.recapSummary, auto: p.auto === true },
        });
      } else {
        notify("_x.ai/session_notification", {
          sessionId,
          update: { sessionUpdate: "session_recap_unavailable" },
        });
      }
    });
    return respond({ result: { ok: true } });
  },
  // P9 mid-turn / queue
  "x.ai/btw": ({ p, respond }) => {
    return respond({ result: { answer: `Side answer: ${String(p.question ?? "")}` } });
  },
  "x.ai/interject": ({ p, sessionId, respond }) => {
    const text = String(p.text ?? "");
    const interjectionId = typeof p.interjectionId === "string" ? p.interjectionId : undefined;
    queueMicrotask(() => {
      notify("x.ai/session/interjection", {
        sessionId: String(p.sessionId ?? sessionId),
        text,
        ...(interjectionId ? { interjectionId } : {}),
      });
    });
    return respond({ result: { status: "queued" } });
  },
  "x.ai/queue/remove": emptyResponse,
  "x.ai/queue/clear": emptyResponse,
  "x.ai/permissions/reset": emptyResponse,
};
