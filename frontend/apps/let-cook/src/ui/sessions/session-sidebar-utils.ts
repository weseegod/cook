import { basename } from "../../acp/attachments";
import type { SessionSummary } from "../../acp/xai";
import { readLocal, writeLocal } from "../storage";

/** How the conversation list is ordered: newest first, or grouped per workspace. */
export type ConversationSort = "time" | "workspace";

/** One rendered block of conversations: the pinned block, or a workspace (or the flat time list). */
export interface ConversationGroup {
  key: string;
  /** Header text; `undefined` leaves the group headerless (the default time list). */
  label?: string;
  /** Full workspace path, for the header's tooltip. */
  path?: string;
  pinned: boolean;
  sessions: SessionSummary[];
}

/** Everything the sidebar remembers about the conversation list between launches. */
export interface ConversationPrefs {
  sort: ConversationSort;
  /** Conversation ids pinned above the rest. */
  pinned: string[];
  /** Ids the user arranged by hand, in display order; wins over recency for those ids. */
  order: string[];
}

export const DEFAULT_PREFS: ConversationPrefs = { sort: "time", pinned: [], order: [] };

const PREFS_KEY = "sessionSidebar";
/** Conversations with no `cwd` share this group key. */
const NO_WORKSPACE_KEY = "__no_workspace__";

export function parsePrefs(raw: string | null): ConversationPrefs {
  if (!raw) return DEFAULT_PREFS;
  try {
    const value = JSON.parse(raw) as Partial<ConversationPrefs> | null;
    if (!value || typeof value !== "object") return DEFAULT_PREFS;
    return {
      sort: value.sort === "workspace" ? "workspace" : "time",
      pinned: idList(value.pinned),
      order: idList(value.order),
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function loadPrefs(): ConversationPrefs {
  return parsePrefs(readLocal(PREFS_KEY));
}

export function savePrefs(prefs: ConversationPrefs): void {
  writeLocal(PREFS_KEY, JSON.stringify(prefs));
}

/** Add or remove an id from the pinned list, keeping the existing arrangement. */
export function togglePinned(pinned: string[], id: string): string[] {
  return pinned.includes(id) ? pinned.filter((entry) => entry !== id) : [...pinned, id];
}

export function prunePrefs(prefs: ConversationPrefs, id: string): ConversationPrefs {
  return {
    ...prefs,
    pinned: prefs.pinned.filter((entry) => entry !== id),
    order: prefs.order.filter((entry) => entry !== id),
  };
}

/** Move an id next to a target id. Ids outside both arguments keep their relative position. */
export function moveId(order: string[], draggedId: string, targetId: string, position: "before" | "after"): string[] {
  if (draggedId === targetId) return order;
  const next = order.filter((id) => id !== draggedId);
  const index = next.indexOf(targetId);
  if (index === -1) return order;
  next.splice(position === "before" ? index : index + 1, 0, draggedId);
  return next;
}

/**
 * Newest first. Conversations the agent reports without a usable timestamp sort last, then by
 * title, so the list never reshuffles on its own.
 */
export function sortByRecency(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((left, right) => {
    const delta = timeOf(right) - timeOf(left);
    if (delta !== 0) return delta;
    return titleOf(left).localeCompare(titleOf(right)) || left.id.localeCompare(right.id);
  });
}

/**
 * Apply the hand-made order, then recency for what it does not cover.
 *
 * Ids missing from `order` (a conversation created since the last drag) sit on top, newest first,
 * so a new conversation is never buried under an old arrangement.
 */
export function arrangeSessions(sessions: SessionSummary[], order: string[]): SessionSummary[] {
  if (order.length === 0) return sortByRecency(sessions);
  const positioned = new Map(order.map((id, index) => [id, index]));
  const known: SessionSummary[] = [];
  const unknown: SessionSummary[] = [];
  for (const session of sessions) (positioned.has(session.id) ? known : unknown).push(session);
  known.sort((left, right) => positioned.get(left.id)! - positioned.get(right.id)!);
  return [...sortByRecency(unknown), ...known];
}

/**
 * Split the list into the pinned block plus, per sort mode, either one flat block or one block per
 * workspace. Workspace blocks are ordered by their most recent conversation.
 */
export function groupConversations(sessions: SessionSummary[], prefs: ConversationPrefs): ConversationGroup[] {
  const pinnedSessions = sessions.filter((session) => prefs.pinned.includes(session.id));
  const rest = sessions.filter((session) => !prefs.pinned.includes(session.id));
  const groups: ConversationGroup[] = [];
  if (pinnedSessions.length > 0) {
    groups.push({ key: "pinned", label: "Pinned", pinned: true, sessions: arrangeSessions(pinnedSessions, prefs.order) });
  }
  if (prefs.sort === "time") {
    groups.push({ key: "recent", pinned: false, sessions: arrangeSessions(rest, prefs.order) });
    return groups;
  }
  for (const [, workspaceSessions] of workspaceBuckets(rest)) {
    const [first] = workspaceSessions;
    groups.push({
      key: first.cwd ?? NO_WORKSPACE_KEY,
      label: first.cwd ? basename(first.cwd) : "No workspace",
      path: first.cwd,
      pinned: false,
      sessions: arrangeSessions(workspaceSessions, prefs.order),
    });
  }
  return groups;
}

/** Conversation ids in the order the groups paint them; the input to a drag reorder. */
export function flattenGroupIds(groups: ConversationGroup[]): string[] {
  return groups.flatMap((group) => group.sessions.map((session) => session.id));
}

function workspaceBuckets(sessions: SessionSummary[]): Map<string, SessionSummary[]> {
  const buckets = new Map<string, SessionSummary[]>();
  for (const session of sortByRecency(sessions)) {
    const key = session.cwd ?? NO_WORKSPACE_KEY;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(session);
    else buckets.set(key, [session]);
  }
  return buckets;
}

function timeOf(session: SessionSummary): number {
  const value = new Date(session.updatedAt ?? Number.NaN).valueOf();
  return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
}

function titleOf(session: SessionSummary): string {
  return session.title ?? "";
}

function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))];
}
