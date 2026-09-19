/**
 * The body a *running* thinking row paints.
 *
 * The TUI wraps the block, then shows an ellipsis and the last `truncated_lines` visual lines
 * (`scrollback/blocks/thinking.rs::render_truncated`, `ThinkingConfig.truncated_lines`). Desktop
 * wraps in CSS, so this side trims to the last few source lines and the row clips any wrap overflow.
 */

/** Lines kept in the truncated body (`truncated_lines` defaults to 3). */
export const THINKING_TRUNCATED_LINES = 3;

export interface ThinkingPreview {
  /** The tail the row paints, with trailing blank lines dropped. */
  text: string;
  /** True when earlier lines were dropped, so the row owes the `…` cue. */
  truncated: boolean;
}

export function thinkingPreview(text: string, lines = THINKING_TRUNCATED_LINES): ThinkingPreview {
  const trimmed = text.replace(/\s+$/, "");
  if (trimmed === "") return { text: "", truncated: false };
  const all = trimmed.split("\n");
  if (all.length <= lines) return { text: all.join("\n"), truncated: false };
  return { text: all.slice(all.length - lines).join("\n"), truncated: true };
}
