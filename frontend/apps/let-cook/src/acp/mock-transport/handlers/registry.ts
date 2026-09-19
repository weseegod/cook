import { mcpHandlers } from "./mcp";
import { planHandlers } from "./plans";
import { sessionHandlers } from "./sessions";
import { settingsHandlers } from "./settings";
import { taskHandlers } from "./tasks";
import { turnHandlers } from "./turn";
import { workspaceHandlers } from "./workspace";

export interface HandlerContext {
  p: Record<string, unknown>;
  sessionId: string;
  respond: (value: unknown) => unknown;
}

export type MethodHandler = (ctx: HandlerContext) => unknown | Promise<unknown>;

const handlers: Record<string, MethodHandler> = {
  ...sessionHandlers,
  ...planHandlers,
  ...settingsHandlers,
  ...mcpHandlers,
  ...taskHandlers,
  ...workspaceHandlers,
  ...turnHandlers,
};

export async function dispatch(method: string, params: unknown): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>;
  const sessionId = "mock-session";
  const respond = (value: unknown) => value;

  // hasOwn keeps wire method names such as `toString` off Object.prototype.
  if (!Object.hasOwn(handlers, method)) return respond({});
  return await handlers[method]({ p, sessionId, respond });
}
