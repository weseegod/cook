import { ChevronDown, LoaderCircle, Minimize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { acpClient } from "../../acp/client";
import { useSessionStore } from "../../state/session";
import { formatTokensCompact } from "./format-duration";

/**
 * Header context occupancy (`views/agent_status.rs`): compact `8.5K/1.0M` with a `/compact` menu.
 * Lives on the status bar, not above the composer.
 */
export function ContextChip() {
  const usage = useSessionStore((state) => state.usage);
  const [menuOpen, setMenuOpen] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function closeOnOutsideClick(event: MouseEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [menuOpen]);

  async function compactConversation() {
    if (compacting) return;
    setMenuOpen(false);
    setCompacting(true);
    useSessionStore.getState().set({ notice: null, error: null });
    try {
      if (useSessionStore.getState().turnRunning) acpClient.queuePrompt("/compact");
      else await acpClient.prompt("/compact");
    } catch (error) {
      useSessionStore.getState().set({
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCompacting(false);
    }
  }

  return (
    <div className="context-chip" ref={root}>
      <button
        type="button"
        className="context-chip-trigger"
        onClick={() => setMenuOpen((open) => !open)}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        aria-label="Context status"
        title="Context window usage"
        data-testid="context-chip"
      >
        <span className="context-chip-usage">{tokenSummary(usage)}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {menuOpen && (
        <div className="context-chip-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => void compactConversation()} disabled={compacting}>
            {compacting ? <LoaderCircle className="spin" size={13} /> : <Minimize2 size={13} />}
            <span>
              <strong>/compact</strong>
              <small>Compress conversation history</small>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

function tokenSummary(usage: Record<string, unknown> | null): string {
  const used = Number(usage?.used ?? usage?.totalTokens ?? 0);
  if (!Number.isFinite(used) || used <= 0) return "—";
  const size = Number(usage?.size ?? 0);
  const usedLabel = formatTokensCompact(used);
  if (!Number.isFinite(size) || size <= 0) return usedLabel;
  return `${usedLabel}/${formatTokensCompact(size)}`;
}
