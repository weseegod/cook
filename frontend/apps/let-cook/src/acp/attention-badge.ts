/**
 * Dock/taskbar attention badge: one entry per conversation that needs the user, mirrored to the
 * host's `os_badge` command (`Window::set_badge_count`) and cleared when the window regains focus.
 *
 * Focus, not answering, is what clears it — the same gate the native notifications use
 * (`shouldNotifyTurnComplete`). While the user is looking at the window, the parked card, the toast,
 * and the transcript already say what needs attention, so the mark is only taken in the background.
 */
import { osBadge } from "./host";

/** Conversations currently marked: one entry each, so the count matches the sidebar's alerts. */
const attention = new Set<string>();

/** The count last handed to the host, so a repeat change writes nothing. */
let applied: number | null = null;

/** True while the window is not the user's focus (blurred or hidden). */
function unfocused(): boolean {
  if (typeof document === "undefined") return false;
  return document.hidden || !document.hasFocus();
}

function apply(count: number): void {
  if (applied === count) return;
  applied = count;
  void osBadge(count);
}

/**
 * Mark a conversation as needing the user. No-op in the foreground: a conversation the user is
 * looking at needs no badge, and nothing may be sent while the window is focused.
 */
export function markAttention(sessionId: string): void {
  if (!unfocused()) return;
  if (attention.has(sessionId)) return;
  attention.add(sessionId);
  apply(attention.size);
}

/** Drop one conversation's mark, after the user answers it. */
export function clearAttention(sessionId: string): void {
  if (!attention.delete(sessionId)) return;
  apply(attention.size);
}

/** Drop every mark, leaving the icon clean. */
export function clearAllAttention(): void {
  if (attention.size === 0) return;
  attention.clear();
  apply(0);
}

/** Conversations currently marked, for tests and diagnostics. */
export function attentionCount(): number {
  return attention.size;
}

/**
 * Clear the badge whenever the window becomes focused or visible again. Attaches once and returns
 * a disposer, so a caller can hand the listeners back when it unmounts.
 */
export function startAttentionBadge(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => undefined;
  const onFocus = () => clearAllAttention();
  const onVisibility = () => {
    if (!document.hidden) clearAllAttention();
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/** Test seam: forget the marks and the applied count without touching the listeners. */
export function resetAttentionBadgeForTests(): void {
  attention.clear();
  applied = null;
}
