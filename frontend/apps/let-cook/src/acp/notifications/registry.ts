import type { RpcMessage } from "../host";
import { normalizeError } from "../errors";
import { notificationEntries } from "./handlers";
import type { NotificationContext, NotificationEntry } from "./types";

const BY_METHOD = new Map(notificationEntries.map((entry) => [entry.method, entry]));

export function notificationRegistryEntries(): readonly NotificationEntry[] {
  return notificationEntries;
}

export function lookupNotification(method: string): NotificationEntry | undefined {
  return BY_METHOD.get(method);
}

/**
 * Layer 3: agent → client notification (no request id, or notif methods).
 * Unknown methods stay log-only — never throw, never `-32601`.
 */
export async function dispatchNotification(
  message: RpcMessage,
  method: string,
  params: Record<string, unknown>,
  hooks?: Pick<NotificationContext, "refreshModels">,
): Promise<void> {
  const entry = lookupNotification(method);
  if (!entry) {
    if (method) console.debug(`Ignored ACP notification: ${method}`);
    return;
  }
  try {
    await entry.handle({ message, method, params, ...hooks });
  } catch (error) {
    console.debug(`Notification handler failed (${method}): ${normalizeError(error)}`);
  }
}
