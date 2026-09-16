import { CornerDownLeft, FolderOpen, MessageSquarePlus, Settings2, ShieldCheck, Sparkles, Terminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useCatalogStore } from "../../state/catalog";
import { slashEntries } from "../chat/slash-commands";
import { buildPaletteItems, rankPaletteItems, type PaletteItem, type PaletteKind } from "./palette-items";

const ICONS: Record<PaletteKind, ReactElement> = {
  action: <Sparkles size={15} />,
  command: <Terminal size={15} />,
  model: <ShieldCheck size={15} />,
  session: <MessageSquarePlus size={15} />,
};

export function CommandPalette({ onClose, onSelect }: { onClose: () => void; onSelect: (item: PaletteItem) => void }) {
  const { sessions, models, commands } = useCatalogStore();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const items = useMemo(
    // The window's own commands are part of the same catalog here, so Ctrl+K reaches `/plan` too.
    () => rankPaletteItems(buildPaletteItems({ sessions, models, commands: slashEntries(commands) }), query),
    [sessions, models, commands, query],
  );

  useEffect(() => setActive(0), [query]);
  useEffect(() => inputRef.current?.focus(), []);

  return (
    <div className="palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="command-palette-modal" role="dialog" aria-label="Command palette" data-testid="command-palette">
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder="Search sessions, models, commands, actions…"
          aria-label="Command palette search"
          data-testid="palette-input"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => Math.min(index + 1, Math.max(items.length - 1, 0)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              const item = items[active];
              if (item) {
                onSelect(item);
                onClose();
              }
            }
          }}
        />
        <ul className="palette-results" role="listbox">
          {items.map((item, index) => (
            <li key={item.id}>
              <button
                className={index === active ? "active" : ""}
                role="option"
                aria-selected={index === active}
                data-testid={`palette-item-${item.id.replace(/:/g, "-")}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => {
                  onSelect(item);
                  onClose();
                }}
              >
                <span className="palette-icon">{ICONS[item.kind]}</span>
                <span className="palette-label">{item.label}</span>
                {item.detail && <small>{item.detail}</small>}
                <span className="palette-kind">{item.kind}</span>
              </button>
            </li>
          ))}
          {items.length === 0 && <li className="palette-empty">Nothing matches “{query}”.</li>}
        </ul>
        <footer className="palette-footer">
          <span><FolderOpen size={13} /> ↑↓ to move</span>
          <span><CornerDownLeft size={13} /> Enter to open</span>
          <span><Settings2 size={13} /> Esc to close</span>
        </footer>
      </section>
    </div>
  );
}
