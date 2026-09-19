import { ArrowUpFromLine, ChevronDown, GitBranch, GitCommitHorizontal, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { acpClient } from "../../acp/client";
import { normalizeError } from "../../acp/errors";
import { loadGitStatus, type GitStatusSummary } from "../../acp/workspace";
import { GIT_HEAD_CHANGED_EVENT } from "../../state/artifacts";
import { useSessionStore } from "../../state/session";

/** How often the dirty-tree probe re-runs while the header is mounted. */
const POLL_INTERVAL_MS = 4_000;

/**
 * Header git chip: appears once the workspace has uncommitted changes and opens a
 * `/commit` / `/commit-and-push` menu on hover or click. Detection is a counts-only
 * `git status` probe — the per-file diff stays in the Review panel's on-demand snapshot.
 */
export function GitChip() {
  const [status, setStatus] = useState<GitStatusSummary | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [sending, setSending] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const cwd = useSessionStore((state) => state.cwd);
  const turnRunning = useSessionStore((state) => state.turnRunning);

  const refresh = useCallback(async () => {
    try {
      setStatus(await loadGitStatus());
    } catch {
      // No workspace sidecar (a plain browser without the mock transport): keep the chip hidden.
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, cwd]);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // A commit moves HEAD; a finished turn is when the edits themselves land.
  useEffect(() => {
    const onGitHead = () => void refresh();
    window.addEventListener(GIT_HEAD_CHANGED_EVENT, onGitHead);
    return () => window.removeEventListener(GIT_HEAD_CHANGED_EVENT, onGitHead);
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh, turnRunning]);

  useEffect(() => {
    if (!menuOpen) return;
    function closeOnOutsideClick(event: MouseEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [menuOpen]);

  async function run(command: "/commit" | "/commit-and-push") {
    if (sending) return;
    // Choosing an action dismisses the menu even though the pointer is still over the chip:
    // leaving `hovered` set would hold it open across the running turn.
    setMenuOpen(false);
    setHovered(false);
    setSending(true);
    useSessionStore.getState().set({ notice: null, error: null });
    try {
      // Busy means the command queues and runs as its own turn, like `/compact`.
      if (useSessionStore.getState().turnRunning) acpClient.queuePrompt(command);
      else await acpClient.prompt(command);
    } catch (error) {
      useSessionStore.getState().set({
        error: normalizeError(error, "Could not start the commit"),
      });
    } finally {
      setSending(false);
    }
  }

  const dirty = Boolean(status?.isGitRepo) && (status!.changedFiles > 0 || status!.operationInProgress);
  const open = menuOpen || hovered;
  if (!dirty) return null;

  const changed = status!.changedFiles === 1 ? "1 changed file" : `${status!.changedFiles} changed files`;
  const counts = status!.additions > 0 || status!.deletions > 0 ? ` · +${status!.additions} −${status!.deletions}` : "";
  const branch = status!.branch ? ` on ${status!.branch}` : "";
  const label = status!.operationInProgress
    ? `Git operation in progress${branch}`
    : `${changed}${branch}${counts}`;

  return (
    <div
      className="git-chip"
      ref={root}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className="git-chip-trigger"
        data-testid="git-chip"
        onClick={() => setMenuOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Workspace changes"
        title={label}
      >
        {sending ? <LoaderCircle className="spin" size={14} /> : <GitBranch size={14} />}
        <span className="git-chip-count" data-testid="git-chip-count">{status!.changedFiles}</span>
        <ChevronDown size={11} aria-hidden="true" />
      </button>
      {open && (
        <div className="git-chip-menu" role="menu" data-testid="git-chip-menu">
          <button
            type="button"
            role="menuitem"
            data-testid="git-commit"
            disabled={sending}
            onClick={() => void run("/commit")}
          >
            <GitCommitHorizontal size={13} />
            <span>
              <strong>Commit</strong>
              <small>Write a message and commit the changes</small>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="git-commit-and-push"
            disabled={sending}
            onClick={() => void run("/commit-and-push")}
          >
            <ArrowUpFromLine size={13} />
            <span>
              <strong>Commit and push</strong>
              <small>Commit, merge the upstream branch, then push</small>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
