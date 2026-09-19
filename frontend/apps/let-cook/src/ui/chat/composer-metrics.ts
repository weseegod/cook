import type { TranscriptBlock } from "../../state/session";

/** Same 4-char heuristic used when the API does not stream usage. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.round(text.length / 4);
}

/**
 * Tokens/sec for a finished reply. Null when there is nothing meaningful to show
 * (no tokens, or decode window shorter than 200ms).
 */
export function computeTps(tokens: number, decodeMs: number): number | null {
  if (tokens === 0 || decodeMs < 200) return null;
  return Math.round(((tokens * 1000) / decodeMs) * 10) / 10;
}

/** One decimal below 100, whole number at 100+. */
export function formatTps(tps: number): string {
  if (tps >= 100) return String(Math.round(tps));
  return tps.toFixed(1);
}

/** Concatenate assistant message text for one turn; ignore thought / user / tools. */
export function assistantTextForTurn(blocks: readonly TranscriptBlock[], turnId: string | null): string {
  if (!turnId) return "";
  let text = "";
  for (const block of blocks) {
    if (block.type !== "message" || block.role !== "assistant" || block.turnId !== turnId) continue;
    text += block.text;
  }
  return text;
}

/**
 * Everything the model decoded in one turn: prose plus thinking. The tokens/sec meter counts both,
 * because a thinking-heavy turn still produces tokens (`views/turn_status.rs` charges the whole
 * decode window the same way).
 */
export function decodeTextForTurn(blocks: readonly TranscriptBlock[], turnId: string | null): string {
  if (!turnId) return "";
  let text = "";
  for (const block of blocks) {
    if (block.type !== "message" || block.turnId !== turnId) continue;
    if (block.role !== "assistant" && block.role !== "thought") continue;
    text += block.text;
  }
  return text;
}

/**
 * Prefer the turn id captured when the turn opened; if that yields no assistant text
 * (cursor replaced mid-turn), fall back to the latest assistant message's turn id.
 */
export function resolveMetricsTurnId(
  blocks: readonly TranscriptBlock[],
  capturedTurnId: string | null,
): string | null {
  if (capturedTurnId && assistantTextForTurn(blocks, capturedTurnId).length > 0) return capturedTurnId;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.type === "message" && block.role === "assistant" && block.turnId) return block.turnId;
  }
  return capturedTurnId;
}

/** Model is producing tokens (prose or thoughts). Excludes tools / waits / ask cards. */
export function isDecodeActivity(activityKind: string | null | undefined): boolean {
  return activityKind === "responding" || activityKind === "thinking";
}

/**
 * Accumulates wall time spent in thinking/responding for the open turn.
 * Module-level: no React setState while the turn runs.
 */
export class DecodeWindowTracker {
  private decodingSince: number | null = null;
  private accumulatedMs = 0;

  /** Call whenever `activity.kind` or turnRunning changes. */
  sync(activityKind: string | null | undefined, turnRunning: boolean, now = Date.now()): void {
    const decoding = turnRunning && isDecodeActivity(activityKind);
    if (decoding) {
      if (this.decodingSince === null) this.decodingSince = now;
      return;
    }
    this.flushOpen(now);
  }

  /** End of turn: flush open window, return total ms, reset. */
  finish(now = Date.now()): number {
    this.flushOpen(now);
    const total = this.accumulatedMs;
    this.reset();
    return total;
  }

  /**
   * Decode time so far without closing the open window — the live denominator for the in-flight
   * tokens/sec. Reads the clock, so callers read it at paint time rather than storing it.
   */
  liveMs(now = Date.now()): number {
    const open = this.decodingSince === null ? 0 : Math.max(0, now - this.decodingSince);
    return this.accumulatedMs + open;
  }

  reset(): void {
    this.decodingSince = null;
    this.accumulatedMs = 0;
  }

  private flushOpen(now: number): void {
    if (this.decodingSince === null) return;
    this.accumulatedMs += Math.max(0, now - this.decodingSince);
    this.decodingSince = null;
  }
}
