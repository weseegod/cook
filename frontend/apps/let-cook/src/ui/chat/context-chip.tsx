import { ChevronDown, LoaderCircle, Minimize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { acpClient } from "../../acp/client";
import { normalizeError } from "../../acp/errors";
import { useSessionStore } from "../../state/session";

const HOVER_PERCENTAGE_WIDTH = 6;

interface ContextUsage {
  percentage: number;
  summary: string;
  barWidth: number;
}

/**
 * Header context occupancy (`views/agent_status.rs`): compact `8.5K / 1.0M` with a `/compact` menu.
 * Lives on the status bar, not above the composer.
 */
export function ContextChip() {
  const usage = useSessionStore((state) => state.usage);
  const [menuOpen, setMenuOpen] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const contextUsage = getContextUsage(usage);
  const showMeter = Boolean(contextUsage && (hovered || focused));

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
        error: normalizeError(error, "Could not compact the conversation"),
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
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
        <span
          className="context-chip-display"
          style={{
            width: `${contextUsage ? Math.max(contextUsage.summary.length, HOVER_PERCENTAGE_WIDTH) : tokenSummary(usage).length}ch`,
          }}
        >
          {showMeter && contextUsage ? (
            <span className="context-chip-hover-usage">
              <span
                className="context-chip-meter"
                role="progressbar"
                aria-label="Context window used"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(contextUsage.percentage)}
                data-tone={usageTone(contextUsage.percentage)}
                data-testid="context-chip-meter"
                style={{ width: `${contextUsage.barWidth}ch` }}
              >
                <span
                  className="context-chip-meter-fill"
                  data-tone={usageTone(contextUsage.percentage)}
                  data-testid="context-chip-meter-fill"
                  style={{
                    width: `${contextUsage.percentage}%`,
                    minWidth: contextUsage.percentage > 0 ? "2px" : "0",
                  }}
                />
              </span>
              <span className="context-chip-percentage" data-testid="context-chip-percent">
                {formatUsagePercentage(contextUsage.percentage)}
              </span>
            </span>
          ) : (
            <span className="context-chip-usage">
              {contextUsage?.summary ?? tokenSummary(usage)}
            </span>
          )}
        </span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {menuOpen && (
        <div className="context-chip-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => void compactConversation()}
            disabled={compacting}
          >
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
  const used = numericValue(usage?.used ?? usage?.totalTokens);
  if (used === null || used < 0) return "—";
  const total = numericValue(usage?.size ?? usage?.total);
  const usedLabel = formatContextTokens(used);
  if (total === null || total <= 0) return usedLabel;
  return `${usedLabel} / ${formatContextTokens(total)}`;
}

function getContextUsage(usage: Record<string, unknown> | null): ContextUsage | null {
  const used = numericValue(usage?.used ?? usage?.totalTokens);
  const total = numericValue(usage?.size ?? usage?.total);
  if (used === null || used < 0 || total === null || total <= 0) return null;

  const percentage = Math.min(100, Math.max(0, (used / total) * 100));
  const summary = tokenSummary(usage);
  const displayWidth = Math.max(summary.length, HOVER_PERCENTAGE_WIDTH);
  return {
    percentage,
    summary,
    barWidth: displayWidth - HOVER_PERCENTAGE_WIDTH,
  };
}

function numericValue(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Matches `views/context_bar.rs::fmt_tokens` so the normal chip and TUI use the same labels. */
function formatContextTokens(tokens: number): string {
  const value = Math.max(0, Math.floor(tokens));
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}K`;
  if (value < 1_000_000) return `${Math.floor(value / 1_000)}K`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.floor(value / 1_000_000)}M`;
}

/** Matches `views/context_bar.rs::fmt_pct5`; the fixed width keeps the hover layout stable. */
function formatUsagePercentage(percentage: number): string {
  if (percentage >= 100) return "MAX %";
  return percentage < 10 ? `${percentage.toFixed(2)}%` : `${percentage.toFixed(1)}%`;
}

function usageTone(percentage: number): "normal" | "warning" | "danger" {
  if (percentage >= 95) return "danger";
  if (percentage >= 75) return "warning";
  return "normal";
}
