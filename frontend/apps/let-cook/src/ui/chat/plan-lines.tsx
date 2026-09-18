import { commentLineLabel, type PlanComment } from "../../state/plan-review";

/**
 * The plan body as the TUI's line viewer holds it: one row per source line, carrying its 1-based
 * number, so a pointer drag maps to an unambiguous line range (`views/file_search/line_viewer.rs`).
 * Comment rows are spliced in directly beneath the line they anchor to, labelled `L3` / `L3-4`.
 *
 * The plan is rendered per line rather than as reflowed markdown for the same reason: reflowing
 * would break the line ↔ row identity the comment ranges depend on.
 */

type LineKind =
  | { kind: "heading"; level: number; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "ordered"; marker: string; text: string }
  | { kind: "quote"; text: string }
  | { kind: "fence" }
  | { kind: "code"; text: string }
  | { kind: "blank" }
  | { kind: "text"; text: string };

/** Classifies one source line for display. Marker text is dropped; the line number never moves. */
export function planLineKind(line: string, inFence: boolean): LineKind {
  if (inFence) return line.trimStart().startsWith("```") ? { kind: "fence" } : { kind: "code", text: line };
  if (/^\s*```/.test(line)) return { kind: "fence" };
  if (line.trim() === "") return { kind: "blank" };
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) return { kind: "heading", level: heading[1].length, text: heading[2] };
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return { kind: "bullet", text: bullet[2] };
  const ordered = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line);
  if (ordered) return { kind: "ordered", marker: ordered[2], text: ordered[3] };
  const quote = /^\s*>\s?(.*)$/.exec(line);
  if (quote) return { kind: "quote", text: quote[1] };
  return { kind: "text", text: line };
}

/** Inline `` `code` `` and `**bold**`, the two the plans in this repo actually use. */
export function planInline(text: string): Array<{ text: string; code?: boolean; bold?: boolean }> {
  const spans: Array<{ text: string; code?: boolean; bold?: boolean }> = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) spans.push({ text: text.slice(cursor, index) });
    const token = match[0];
    if (token.startsWith("`")) spans.push({ text: token.slice(1, -1), code: true });
    else spans.push({ text: token.slice(2, -2), bold: true });
    cursor = index + token.length;
  }
  if (cursor < text.length) spans.push({ text: text.slice(cursor) });
  return spans;
}

function PlanLineText({ kind }: { kind: LineKind }) {
  if (kind.kind === "blank" || kind.kind === "fence") {
    return <span className="plan-line-text plan-line-blank"> </span>;
  }
  if (kind.kind === "bullet") {
    return (
      <span className="plan-line-text">
        <span className="plan-line-marker" aria-hidden="true">•</span>
        {planInline(kind.text).map((span, index) => <PlanSpan key={index} span={span} />)}
      </span>
    );
  }
  if (kind.kind === "ordered") {
    return (
      <span className="plan-line-text">
        <span className="plan-line-marker">{kind.marker}</span>
        {planInline(kind.text).map((span, index) => <PlanSpan key={index} span={span} />)}
      </span>
    );
  }
  return (
    <span className="plan-line-text">
      {planInline(kind.text).map((span, index) => <PlanSpan key={index} span={span} />)}
    </span>
  );
}

function PlanSpan({ span }: { span: { text: string; code?: boolean; bold?: boolean } }) {
  if (span.code) return <code>{span.text}</code>;
  if (span.bold) return <strong>{span.text}</strong>;
  return <>{span.text}</>;
}

export interface PlanLinesProps {
  lines: readonly string[];
  comments: readonly PlanComment[];
  /** `[lo, hiExclusive)` while dragging or after a selection; drives the highlight band. */
  selectedRange: [number, number] | null;
  activeCommentId: number | null;
  onSelectLine: (line: number, extend: boolean) => void;
  /** Fires while the pointer is down and moves onto another row, extending the drag range. */
  onHoverLine: (line: number) => void;
  /** Pointer-up: `selected` is the range the drag ended on. */
  onCommitSelection: (selected: [number, number] | null) => void;
  onSelectComment: (id: number) => void;
}

export function PlanLines({
  lines,
  comments,
  selectedRange,
  activeCommentId,
  onSelectLine,
  onHoverLine,
  onCommitSelection,
  onSelectComment,
}: PlanLinesProps) {
  let inFence = false;
  // Comment rows are inserted under the last line of their range, ordered as the pager orders them.
  const byAnchor = new Map<number, PlanComment[]>();
  for (const comment of comments) {
    const anchor = comment.lineRange[1] - 1;
    byAnchor.set(anchor, [...(byAnchor.get(anchor) ?? []), comment]);
  }

  return (
    <ol
      className="plan-lines"
      data-testid="plan-lines"
      onPointerUp={() => onCommitSelection(selectedRange)}
      onPointerLeave={() => onCommitSelection(selectedRange)}
    >
      {lines.map((line, index) => {
        const number = index + 1;
        const kind = planLineKind(line, inFence);
        if (kind.kind === "fence") inFence = !inFence;
        const selected = selectedRange !== null && number >= selectedRange[0] && number < selectedRange[1];
        const heading = kind.kind === "heading" ? ` plan-line-h${kind.level}` : "";
        const anchored = byAnchor.get(number) ?? [];
        return (
          <li key={number} className="plan-line-item">
            <button
              type="button"
              className={`plan-line plan-line-${kind.kind}${heading}${selected ? " plan-line-selected" : ""}`}
              data-testid={`plan-line-${number}`}
              data-line={number}
              aria-pressed={selected}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                onSelectLine(number, event.shiftKey);
              }}
              onPointerEnter={() => onHoverLine(number)}
            >
              <span className="plan-line-gutter" aria-hidden="true">{number}</span>
              <PlanLineText kind={kind} />
            </button>
            {anchored.map((comment) => (
              <button
                key={comment.id}
                type="button"
                className={`plan-comment-line${comment.id === activeCommentId ? " plan-comment-active" : ""}`}
                data-testid={`plan-comment-${comment.id}`}
                onClick={() => onSelectComment(comment.id)}
              >
                <span className="plan-comment-label">{commentLineLabel(comment.lineRange)}</span>
                <span className="plan-comment-text">{comment.text}</span>
              </button>
            ))}
          </li>
        );
      })}
    </ol>
  );
}
