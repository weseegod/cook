/**
 * Browser-transport stand-in for the real agent.
 *
 * Only active when `VITE_MOCK_ACP=1` (dev server / Playwright). It exists so the shipped
 * renderer can be driven end to end outside Tauri: it records the RPC params the real client
 * sends, keeps provider/connector state the way the agent would, and can stream assistant
 * updates back so the transcript is exercised for real.
 */
import {
  goalUpdate,
  mockElicit,
  mockModelsUpdate,
  mockPatchWorkspaceReview,
  mockPermission,
  mockPlan,
  mockQuestion,
  mockQueueChanged,
  mockSessionNotification,
  mockSessionUpdate,
  mockSeedTranscript,
  mockTaskBackgrounded,
  mockTaskCompleted,
  mockTaskOutput,
} from "./mock-transport/events";
import { completeMockOauth } from "./mock-transport/handlers/settings";
import { dispatch } from "./mock-transport/handlers/registry";
import { mockRequests, mockReset, mockState, persist, record, responses } from "./mock-transport/state";
import type { MockControl } from "./mock-transport/types";

export * from "./mock-transport/types";
export * from "./mock-transport/state";
export * from "./mock-transport/catalog";
export * from "./mock-transport/events";

/**
 * Mirrors the agent's routing: extension calls arrive as `_x.ai/...` and are dispatched by the
 * bare name, so what the tests read back is the logical method the app asked for. A bare
 * `x.ai/...` request is rejected exactly as the agent rejects it, so a call site that skips the
 * wire prefix fails here instead of only against a real agent.
 */
const METHOD_NOT_FOUND = '{"code":-32601,"message":"Method not found"}';

/** Runs one mocked call and persists the result, the way the agent's config.toml would. */
export async function mockRequest<T>(rawMethod: string, params: unknown): Promise<T> {
  if (rawMethod.startsWith("x.ai/")) throw new Error(METHOD_NOT_FOUND);
  const method = rawMethod.startsWith("_x.ai/") ? rawMethod.slice(1) : rawMethod;
  record(method, params);
  const value = await dispatch(method, params);
  persist();
  return value as T;
}

declare global {
  interface Window {
    __cookMock?: MockControl;
  }
}

if (typeof window !== "undefined") {
  window.__cookMock = {
    reset: mockReset,
    requests: mockRequests,
    state: mockState,
    responses: () => [...responses],
    elicit: mockElicit,
    permission: mockPermission,
    question: mockQuestion,
    plan: mockPlan,
    sessionNotification: mockSessionNotification,
    queueChanged: mockQueueChanged,
    sessionUpdate: mockSessionUpdate,
    seedTranscript: mockSeedTranscript,
    workspaceReview: mockPatchWorkspaceReview,
    taskBackgrounded: mockTaskBackgrounded,
    taskCompleted: mockTaskCompleted,
    taskOutput: mockTaskOutput,
    goalUpdate,
    modelsUpdate: mockModelsUpdate,
    completeOAuth: completeMockOauth,
  };
}
