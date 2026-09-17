/**
 * Duration formatting copied from the TUI (`xai-grok-pager-render/src/util.rs::format_duration`).
 * No spaces, ever: `<10s` keeps one decimal, then whole seconds, then `{m}m{s}s`, then `{h}h{m}m`.
 */
export function formatDuration(milliseconds: number): string {
  const duration = Math.max(0, milliseconds);
  const totalSeconds = Math.floor(duration / 1000);
  if (totalSeconds < 10) return `${(duration / 1000).toFixed(1)}s`;
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m${totalSeconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/**
 * Thinking headers use their own formatter (`scrollback/blocks/thinking.rs::format_time`):
 * one decimal under a minute, then `{m}m{s}s` with whole seconds.
 */
export function formatThinkingDuration(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
}

/** Compact token counts beside the turn timer, matching `views/turn_status.rs::format_tokens_short`. */
export function formatTokensShort(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(2)}k`;
  if (tokens < 100_000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.floor(tokens / 1000)}k`;
  if (tokens < 10_000_000) return `${(tokens / 1_000_000).toFixed(2)}m`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}
