/**
 * Command-palette item construction and ranking (pure).
 *
 * The palette indexes sessions, models, slash commands, and app actions in one list; ranking is
 * deterministic so the same query always surfaces the same order.
 */
import type { CommandSummary, ModelSummary, SessionSummary } from "../../acp/xai";

export type PaletteKind = "action" | "command" | "model" | "session";

export interface PaletteItem {
  id: string;
  kind: PaletteKind;
  label: string;
  detail?: string;
  /** The action the host performs when the item is accepted. */
  action: string;
  /** Payload for the action (model id, session id, command name). */
  value?: string;
}

export interface PaletteSource {
  sessions?: SessionSummary[];
  models?: ModelSummary[];
  commands?: CommandSummary[];
  actions?: PaletteItem[];
}

export const DEFAULT_ACTIONS: PaletteItem[] = [
  { id: "action:new-session", kind: "action", label: "New conversation", action: "new-session" },
  { id: "action:open-folder", kind: "action", label: "Open folder…", action: "open-folder" },
  { id: "action:settings", kind: "action", label: "Open settings", action: "settings" },
  { id: "action:connect-provider", kind: "action", label: "Connect a provider", action: "connect-provider" },
  { id: "action:palette", kind: "action", label: "Show keyboard shortcuts", action: "shortcuts" },
];

const KIND_PRIORITY: Record<PaletteKind, number> = { action: 0, command: 1, model: 2, session: 3 };

export function buildPaletteItems(source: PaletteSource): PaletteItem[] {
  return [
    ...(source.actions ?? DEFAULT_ACTIONS),
    ...(source.commands ?? []).map((command) => ({
      id: `command:${command.name}`,
      kind: "command" as const,
      label: `/${command.name}`,
      detail: command.description,
      action: "command",
      value: command.name,
    })),
    ...(source.models ?? []).map((model) => ({
      id: `model:${model.id}`,
      kind: "model" as const,
      label: model.name ?? model.id,
      detail: model.provider ? `${model.id} · ${model.provider}` : model.id,
      action: "model",
      value: model.id,
    })),
    ...(source.sessions ?? []).map((session) => ({
      id: `session:${session.id}`,
      kind: "session" as const,
      label: session.title || "Untitled conversation",
      detail: session.cwd,
      action: "session",
      value: session.id,
    })),
  ];
}

/** Higher is better; `0` means "no match at all". */
export function scoreItem(item: PaletteItem, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 1;
  const label = item.label.toLowerCase();
  const detail = (item.detail ?? "").toLowerCase();
  let score = 0;
  if (label === needle) score += 1000;
  else if (label.startsWith(needle)) score += 500;
  else if (new RegExp(`(^|[\\s/_.-])${escapeRegExp(needle)}`).test(label)) score += 300;
  else if (label.includes(needle)) score += 150;
  else if (detail.includes(needle)) score += 60;
  else if (item.kind === "session") return 0;
  else return 0;
  // Shorter labels are usually the intended target.
  return score - Math.min(label.length, 60);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function rankPaletteItems(items: PaletteItem[], query: string, limit = 12): PaletteItem[] {
  const needle = query.trim().toLowerCase();
  const scored = items
    .map((item) => ({ item, score: scoreItem(item, needle) }))
    .filter((entry) => entry.score > 0);
  if (!needle) {
    scored.sort((a, b) => KIND_PRIORITY[a.item.kind] - KIND_PRIORITY[b.item.kind]);
    return scored.slice(0, limit).map((entry) => entry.item);
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const kind = KIND_PRIORITY[a.item.kind] - KIND_PRIORITY[b.item.kind];
    if (kind !== 0) return kind;
    return a.item.label.localeCompare(b.item.label);
  });
  return scored.slice(0, limit).map((entry) => entry.item);
}
