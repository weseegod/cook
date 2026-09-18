import { osNotify } from "./host";

/** True when the desktop window is not the user's focus (tab hidden or blurred). */
export function shouldNotifyTurnComplete(): boolean {
  if (typeof document === "undefined") return false;
  return document.hidden || !document.hasFocus();
}

/**
 * Strip credential-like tokens from notification text. Bodies must never echo API keys,
 * tokens, or secrets from a failed turn's error string.
 */
export function sanitizeNotifyText(text: string): string {
  return text
    .replace(
      /(?:api[_-]?key|access[_-]?token|\btoken\b|secret|password|bearer(?:\s+token)?|authorization)\s*[:=]\s*\S+/gi,
      "[redacted]",
    )
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .slice(0, 240);
}

export type TurnNotifyOutcome = { kind: "completed" } | { kind: "cancelled" } | { kind: "failed"; error?: string };

export function turnCompleteNotifyCopy(outcome: TurnNotifyOutcome): { title: string; body: string } {
  if (outcome.kind === "cancelled") {
    return { title: "Thanh", body: "Turn cancelled" };
  }
  if (outcome.kind === "failed") {
    return { title: "Thanh", body: "Turn failed" };
  }
  return { title: "Thanh", body: "Turn completed" };
}

/**
 * Show a native OS notification when a turn finishes in the background.
 * No-op outside Tauri; never puts credentials in the body.
 */
export async function notifyTurnComplete(title: string, body: string): Promise<void> {
  const safeTitle = sanitizeNotifyText(title) || "Thanh";
  const safeBody = sanitizeNotifyText(body) || "Turn completed";
  await osNotify(safeTitle, safeBody);
}
