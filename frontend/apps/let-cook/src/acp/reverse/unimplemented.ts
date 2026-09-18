import { typedDeclineResult } from "./policy";
import type { ReverseEntry } from "./types";

/**
 * Known but unimplemented reverses. Must typed-decline, never `-32601`,
 * even if a future session meta accidentally enables them (C2 / R-sdk, R-hook).
 */
export const unimplementedEntries: ReverseEntry[] = [
  {
    mapId: "R-sdk",
    method: "x.ai/mcp/sdk_call",
    handle: async () => ({ kind: "decline", result: typedDeclineResult() }),
  },
  {
    mapId: "R-hook",
    method: "x.ai/hooks/run",
    handle: async () => ({ kind: "decline", result: typedDeclineResult() }),
  },
];
