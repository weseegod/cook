import type { RpcMessage } from "../host";

export function unwrapMethod(message: RpcMessage): string | undefined {
  if (message.method?.startsWith("_x.ai/") && typeof message.params?.method === "string") {
    return message.params.method;
  }
  return message.method?.startsWith("_x.ai/") ? message.method.slice(1) : message.method;
}

export function unwrapParams(message: RpcMessage): Record<string, unknown> {
  if (message.method?.startsWith("_x.ai/") && isRecord(message.params?.params)) return message.params.params;
  return message.params ?? {};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a `current_mode_update` reports plan mode, matching the store's own reduction. */
export function planModeIsOn(update: Record<string, unknown> | undefined): boolean {
  const mode = update?.currentModeId ?? update?.modeId;
  return typeof mode === "string" && mode.toLowerCase().includes("plan");
}
