type JsonRecord = Record<string, unknown>;

export type SessionEventRail = "acp" | "xai";

/** Keep the live Desktop transcript aligned with the TUI's event high-water marks. */
export class SessionEventDedupe {
  private readonly highwater = new Map<string, number>();

  accept(rail: SessionEventRail, params: JsonRecord): boolean {
    const meta = asRecord(params._meta) ?? asRecord(params.meta);
    if (meta?.isReplay === true) return true;

    const sequence = eventSequence(meta);
    if (sequence === null) return true;

    const sessionId = stringValue(params.sessionId ?? params.session_id);
    // An event without a session cannot be safely high-water-marked: using a shared
    // "unknown" bucket would let one session suppress another session's update.
    if (!sessionId) return true;
    const key = `${rail}:${sessionId}`;
    const previous = this.highwater.get(key);
    if (previous !== undefined && sequence <= previous) return false;
    this.highwater.set(key, sequence);
    return true;
  }

  clear(): void {
    this.highwater.clear();
  }
}

/** Correlate live updates with prompts currently owned by this Desktop client. */
export class PromptCorrelation {
  private readonly inFlight = new Set<string>();

  begin(promptId: string): void {
    this.inFlight.add(promptId);
  }

  end(promptId: string): void {
    this.inFlight.delete(promptId);
  }

  accept(params: JsonRecord): boolean {
    const meta = asRecord(params._meta) ?? asRecord(params.meta);
    if (meta?.isReplay === true) return true;
    const promptId = promptIdFromParams(params);
    if (!promptId || this.inFlight.size === 0) return true;
    return this.inFlight.has(promptId);
  }

  clear(): void {
    this.inFlight.clear();
  }
}

/** Prompt identity is carried by the notification envelope, not its update payload. */
export function promptIdFromParams(params: JsonRecord): string | null {
  const meta = asRecord(params._meta) ?? asRecord(params.meta);
  return stringValue(params.promptId ?? params.prompt_id ?? meta?.promptId ?? meta?.prompt_id);
}

export function eventSequence(meta: JsonRecord | null): number | null {
  if (!meta) return null;
  const direct = meta.eventSeq ?? meta.event_seq;
  if (typeof direct === "number" && Number.isSafeInteger(direct) && direct >= 0) return direct;
  const eventId = stringValue(meta.eventId ?? meta.event_id);
  if (!eventId) return null;
  const suffix = eventId.slice(eventId.lastIndexOf("-") + 1);
  const sequence = Number(suffix);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
