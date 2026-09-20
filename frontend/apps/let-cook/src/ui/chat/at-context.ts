/**
 * `@`-token detection for composer path search.
 *
 * Port of `crates/codegen/xai-grok-pager/src/views/file_search/context.rs`:
 * cursor-local `@query`, email rejection, hidden `!`, dir `/`, and drill-prefix whitespace.
 */

export interface AtContext {
  /** Inclusive start / exclusive end of the `@…` token (includes `@`). */
  range: { start: number; end: number };
  cursor: number;
  /** Text after `@` up to the cursor (may include a leading `!`). */
  query: string;
}

export function isDirMode(ctx: AtContext): boolean {
  return ctx.query.endsWith("/");
}

export function isHiddenMode(ctx: AtContext): boolean {
  return ctx.query.startsWith("!");
}

/** Query passed to the fuzzy matcher (strips a leading `!`). */
export function matcherQuery(ctx: AtContext): string {
  return ctx.query.startsWith("!") ? ctx.query.slice(1) : ctx.query;
}

/** Range covering only the path portion (skips `@` and an optional `!`). */
export function pathRange(ctx: AtContext): { start: number; end: number } {
  const prefix = 1 + (isHiddenMode(ctx) ? 1 : 0);
  return { start: ctx.range.start + prefix, end: ctx.range.end };
}

export function normalizeDisplayPath(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

export function detect(text: string, cursor: number): AtContext | null {
  return detectWithDrill(text, cursor, null);
}

/**
 * Like `detect`, but whitespace inside `drillPrefix` stays part of the `@`-token
 * so `@my dir/` can keep the menu open while drilling.
 */
export function detectWithDrill(
  text: string,
  cursor: number,
  drillPrefix: string | null | undefined,
): AtContext | null {
  if (cursor < 0 || cursor > text.length) return null;

  const before = text.slice(0, cursor);
  const atIdx = before.lastIndexOf("@");
  if (atIdx < 0) return null;

  const prev = atIdx > 0 ? text[atIdx - 1] : "";
  if (prev && /[A-Za-z0-9_]/.test(prev)) return null;

  const contentStart = atIdx + 1;
  const afterBang = text.startsWith("!", contentStart) ? contentStart + 1 : contentStart;
  const prefix = drillPrefix ?? null;
  const internalUntil =
    prefix && text.slice(afterBang).startsWith(prefix) ? afterBang + prefix.length : null;

  let tokenEnd = text.length;
  for (let i = atIdx + 1; i < text.length; i += 1) {
    const ch = text[i]!;
    if ((/\s/.test(ch) || ch === "," || ch === ";") && (internalUntil === null || i >= internalUntil)) {
      tokenEnd = i;
      break;
    }
  }

  if (cursor > tokenEnd) return null;

  return {
    range: { start: atIdx, end: tokenEnd },
    cursor,
    query: text.slice(atIdx + 1, cursor),
  };
}
