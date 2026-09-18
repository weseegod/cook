/**
 * Mid-turn / queue client→agent wrappers (map C-btw, C-inj, C-q-*).
 * Queue edits are notifications; btw and interject are requests that return a result.
 */
import { CAPABILITIES } from "./handshake";
import { notify, request } from "./host";

/** Ids we minted for optimistic interject echoes — drop matching N-interject broadcasts. */
const selfInterjectionIds = new Set<string>();

export function claimSelfInterjection(id: string): boolean {
  return selfInterjectionIds.delete(id);
}

export function rememberSelfInterjection(id: string): void {
  selfInterjectionIds.add(id);
}

/** `x.ai/btw` — side question that does not interrupt the running turn. */
export function askBtw(sessionId: string, question: string) {
  return request<{ answer?: string }>("x.ai/btw", { sessionId, question });
}

/** `x.ai/interject` — queue a mid-turn interjection for the next safe drain point. */
export async function interjectPrompt(sessionId: string, text: string): Promise<{ status?: string }> {
  const interjectionId = `inj-${crypto.randomUUID()}`;
  rememberSelfInterjection(interjectionId);
  try {
    return await request<{ status?: string }>("x.ai/interject", {
      sessionId,
      text,
      interjectionId,
    });
  } catch (error) {
    selfInterjectionIds.delete(interjectionId);
    throw error;
  }
}

/** `x.ai/queue/remove` — C→A notification (C-q-rm). */
export function removeQueuedPrompt(sessionId: string, id: string, expectedVersion = 0) {
  return notify("x.ai/queue/remove", {
    sessionId,
    id,
    expectedVersion,
    owner: CAPABILITIES.clientIdentifier,
  });
}

/** `x.ai/queue/clear` — C→A notification (C-q-cl). */
export function clearQueuedPrompts(sessionId: string) {
  return notify("x.ai/queue/clear", {
    sessionId,
    clientIdentifier: CAPABILITIES.clientIdentifier,
  });
}
