import type { RpcMessage } from "../host";

export type ReverseDisposition =
  | { kind: "parked" }
  | { kind: "decline"; result: unknown }
  | { kind: "error"; error: { code: number; message: string } };

export interface ReverseContext {
  message: RpcMessage;
  method: string;
  params: Record<string, unknown>;
}

export interface ReverseEntry {
  /** Capability-map row id (e.g. R-ask, R-sdk). */
  mapId: string;
  method: string;
  handle: (ctx: ReverseContext) => Promise<ReverseDisposition>;
}
