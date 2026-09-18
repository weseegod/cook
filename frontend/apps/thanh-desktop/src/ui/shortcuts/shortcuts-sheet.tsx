import { X } from "lucide-react";
import { useEffect } from "react";

export interface ShortcutBinding {
  id: string;
  label: string;
  /** Display keys (platform-agnostic strings for the sheet). */
  keys: string[];
}

/** Bindings shown in the shortcuts overlay (`?` / palette). */
export const SHORTCUT_BINDINGS: ShortcutBinding[] = [
  { id: "palette", label: "Search everything", keys: ["⌘K", "Ctrl+K"] },
  { id: "new-chat", label: "New chat", keys: ["/new"] },
  { id: "settings", label: "Settings", keys: ["⌘,"] },
  { id: "plan", label: "Plan mode", keys: ["/plan"] },
  { id: "stop", label: "Stop turn", keys: ["Esc"] },
  { id: "yolo", label: "Always approve", keys: ["/always-approve"] },
  { id: "review", label: "Review changes", keys: ["⌃⇧G"] },
  { id: "files", label: "Browse files", keys: ["⌘P"] },
];

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w")) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="shortcuts-sheet-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="shortcuts-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-sheet-title"
        data-testid="shortcuts-sheet"
      >
        <header className="shortcuts-sheet-header">
          <h2 id="shortcuts-sheet-title">Keyboard shortcuts</h2>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close shortcuts"
            data-testid="shortcuts-sheet-close"
          >
            <X size={16} />
          </button>
        </header>
        <div className="shortcut-list" aria-label="Keyboard shortcuts">
          {SHORTCUT_BINDINGS.map((binding) => (
            <span key={binding.id} data-testid={`shortcut-${binding.id}`}>
              <span className="shortcut-label">{binding.label}</span>
              <span className="shortcut-keys">
                {binding.keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </span>
            </span>
          ))}
        </div>
        <p className="shortcuts-sheet-hint">Press <kbd>?</kbd> anytime to open this sheet.</p>
      </section>
    </div>
  );
}
