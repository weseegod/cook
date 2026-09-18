import { respond, type RpcMessage } from "../host";
import { interactionEntries } from "./interactions";
import { unknownReverseAnswer } from "./policy";
import type { ReverseContext, ReverseEntry } from "./types";
import { unimplementedEntries } from "./unimplemented";

const ENTRIES: ReverseEntry[] = [...interactionEntries, ...unimplementedEntries];

const BY_METHOD = new Map(ENTRIES.map((entry) => [entry.method, entry]));

export function reverseEntries(): readonly ReverseEntry[] {
  return ENTRIES;
}

export function lookupReverse(method: string): ReverseEntry | undefined {
  return BY_METHOD.get(method);
}

/**
 * Layer 2: agent → client reverse request with an `id`.
 * Returns true when the message was a reverse request (handled or declined).
 */
export async function dispatchReverseRequest(
  message: RpcMessage,
  method: string,
  params: Record<string, unknown>,
): Promise<boolean> {
  if (message.id === undefined) return false;

  const ctx: ReverseContext = { message, method, params };
  const entry = lookupReverse(method);
  if (entry) {
    const disposition = await entry.handle(ctx);
    if (disposition.kind === "parked") return true;
    if (disposition.kind === "decline") {
      await respond(message.id, disposition.result);
      return true;
    }
    await respond(message.id, undefined, disposition.error);
    return true;
  }

  console.warn(`Unsupported agent request (typed decline): ${method}`);
  const answer = unknownReverseAnswer(method);
  if (answer.error) await respond(message.id, undefined, answer.error);
  else await respond(message.id, answer.result);
  return true;
}
