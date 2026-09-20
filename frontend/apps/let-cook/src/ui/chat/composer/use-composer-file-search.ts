import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { indexWorkspace, type WorkspaceIndexEntry } from "../../../acp/workspace";
import {
  detectWithDrill,
  isHiddenMode,
  type AtContext,
} from "../at-context";
import {
  acceptReplacement,
  applyReplacement,
  FILE_SEARCH_VISIBLE,
  rankForContext,
  type FileSearchMatch,
} from "../file-search";

export interface ComposerFileSearch {
  visible: boolean;
  matches: FileSearchMatch[];
  active: number;
  setActive: (index: number) => void;
  onCursor: (cursor: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  accept: (index?: number, options?: { noSpace?: boolean }) => void;
  dismiss: () => void;
}

/**
 * Composer `@` path search: lazy index fetch, fuzzy rank, keyboard accept/drill.
 * Returns `true` from `onKeyDown` when the event was handled (caller should not run slash/submit).
 */
export function useComposerFileSearch(options: {
  text: string;
  setText: (value: string) => void;
  textarea: RefObject<HTMLTextAreaElement | null>;
  /** Slash menu owns the keystream while it has rows. */
  slashOpen: boolean;
  menuClosed: boolean;
  setMenuClosed: (closed: boolean) => void;
}): ComposerFileSearch {
  const { text, setText, textarea, slashOpen, menuClosed, setMenuClosed } = options;
  const [cursor, setCursor] = useState(0);
  const [active, setActive] = useState(0);
  const [drillPrefix, setDrillPrefix] = useState<string | null>(null);
  const [index, setIndex] = useState<WorkspaceIndexEntry[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const fetchGen = useRef(0);

  const ctx: AtContext | null = useMemo(() => {
    if (menuClosed || slashOpen) return null;
    return detectWithDrill(text, cursor, drillPrefix);
  }, [text, cursor, drillPrefix, menuClosed, slashOpen]);

  // Drop a stale drill anchor once the path no longer starts with it.
  useEffect(() => {
    if (!ctx || !drillPrefix) return;
    const pathStart = ctx.range.start + 1 + (isHiddenMode(ctx) ? 1 : 0);
    if (!text.slice(pathStart).startsWith(drillPrefix)) {
      setDrillPrefix(null);
    }
  }, [ctx, drillPrefix, text]);

  // Lazy-load (and refresh when hidden mode toggles).
  useEffect(() => {
    if (!ctx) return;
    const wantHidden = isHiddenMode(ctx);
    if (index && wantHidden === hidden) return;
    const gen = ++fetchGen.current;
    setHidden(wantHidden);
    void indexWorkspace(wantHidden)
      .then((entries) => {
        if (fetchGen.current !== gen) return;
        setIndex(entries);
      })
      .catch(() => {
        if (fetchGen.current !== gen) return;
        setIndex([]);
      });
  }, [ctx, hidden, index]);

  // Fresh `@` token clears any leftover drill.
  useEffect(() => {
    if (!ctx) {
      setDrillPrefix(null);
    }
  }, [ctx]);

  const matches = useMemo(() => {
    if (!ctx || !index) return [];
    return rankForContext(index, ctx).slice(0, FILE_SEARCH_VISIBLE);
  }, [ctx, index]);

  useEffect(() => setActive(0), [ctx?.query, matches.length]);

  const onCursor = useCallback((next: number) => {
    setCursor(next);
  }, []);

  const accept = useCallback(
    (indexOverride?: number, acceptOptions: { noSpace?: boolean } = {}) => {
      if (!ctx || matches.length === 0) return;
      const pick = matches[Math.min(indexOverride ?? active, matches.length - 1)];
      if (!pick) return;
      const replacement = acceptReplacement(text, ctx, pick, acceptOptions);
      const applied = applyReplacement(text, replacement);
      setText(applied.text);
      if (replacement.dismiss) {
        setMenuClosed(true);
        setDrillPrefix(null);
      } else {
        setDrillPrefix(replacement.drillPrefix);
        setMenuClosed(false);
      }
      requestAnimationFrame(() => {
        const node = textarea.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(applied.cursor, applied.cursor);
        setCursor(applied.cursor);
      });
    },
    [active, ctx, matches, setMenuClosed, setText, text, textarea],
  );

  const dismiss = useCallback(() => {
    setMenuClosed(true);
    setDrillPrefix(null);
  }, [setMenuClosed]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!ctx || matches.length === 0 || menuClosed) return false;

      if (event.key === "ArrowDown" || (event.ctrlKey && event.key.toLowerCase() === "n") || (event.ctrlKey && event.key.toLowerCase() === "j")) {
        event.preventDefault();
        setActive((index) => Math.min(index + 1, matches.length - 1));
        return true;
      }
      if (event.key === "ArrowUp" || (event.ctrlKey && event.key.toLowerCase() === "p") || (event.ctrlKey && event.key.toLowerCase() === "k")) {
        event.preventDefault();
        setActive((index) => Math.max(index - 1, 0));
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
        return true;
      }
      if (event.key === "ArrowRight") {
        const pick = matches[Math.min(active, matches.length - 1)];
        if (pick?.kind === "directory") {
          event.preventDefault();
          accept(active, { noSpace: true });
          return true;
        }
        // Files: Right matches Tab.
        event.preventDefault();
        accept(active);
        return true;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        accept(active);
        return true;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        accept(active);
        return true;
      }
      return false;
    },
    [accept, active, ctx, dismiss, matches, menuClosed],
  );

  return {
    visible: Boolean(ctx) && matches.length > 0 && !menuClosed && !slashOpen,
    matches,
    active,
    setActive,
    onCursor,
    onKeyDown,
    accept,
    dismiss,
  };
}
