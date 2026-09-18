import type { RpcMessage } from "../host";

export interface NotificationContext {
  message: RpcMessage;
  method: string;
  params: Record<string, unknown>;
  /** Optional client hooks for notifs that need a round trip (models re-list). */
  refreshModels?: () => Promise<void>;
}

export interface NotificationEntry {
  /** Capability-map row id (e.g. N-mcp-srv, N-pcomplete). */
  mapId: string;
  method: string;
  handle: (ctx: NotificationContext) => Promise<void> | void;
}
