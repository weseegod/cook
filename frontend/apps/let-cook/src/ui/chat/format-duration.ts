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

/**
 * `views/agent_status.rs::format_elapsed_compact`: whole seconds under a minute, then whole
 * minutes, then whole hours. Coarser than {@link formatDuration} and used by the goal chip.
 */
export function formatElapsedCoarse(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${seconds}s`;
}

/**
 * `views/goal_detail.rs::format_elapsed`: `5s`, `3m05s`, `2h03m`. A third formatter on purpose —
 * the goal detail surface keeps the seconds once minutes have started.
 */
export function formatElapsedSeconds(milliseconds: number): string {
  const total = Math.floor(Math.max(0, milliseconds) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** Token counts on the goal surfaces, matching `views/agent_status.rs::format_tokens_compact`. */
export function formatTokensCompact(tokens: number): string {
  const abs = Math.abs(tokens);
  const sign = tokens < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(tokens);
}

/** `xai-grok-pager-render/src/util.rs::format_time_ago`: `just now`, `2m`, `3h`, `4d`, `2mo`, `1y`. */
export function formatTimeAgo(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  const days = Math.floor(seconds / 86400);
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}
