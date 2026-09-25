import { ArrowUpFromLine, ChevronDown, Eye, GitBranch, GitCommitHorizontal, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { acpClient } from "../../acp/client";
import { normalizeError } from "../../acp/errors";
import { useSessionStore } from "../../state/session";
import { useToolsPanelStore } from "../../state/tools-panel";
import { HeaderDiffstat } from "./header-diffstat";
import { useGitStatus, useGitStatusPoll } from "./git-status";

/**
 * Header git chip: branch and line changes, with Preview, Commit, and Commit and push actions.
 * The Preview menu item carries the changed-file count. Detection is the shared counts-only
 * `git status` probe behind {@link useGitStatusPoll} — the per-file diff stays in the Review panel's
 * on-demand snapshot.
 * A clean tree keeps the menu but disables actions that would have nothing to do, and a workspace
 * outside a repository says so rather than vanishing from the header.
 */
export function GitChip() {
  useGitStatusPoll();
  const cwd = useSessionStore((state) => state.cwd);
  const status = useGitStatus(cwd);
  const [menuOpen, setMenuOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [sending, setSending] = useState(false);
  const root = useRef<HTMLDivElement>(null);

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

  // No workspace, or the probe has not answered yet: nothing to name.
  if (!cwd || !status) return null;

  const inRepo = status.isGitRepo;
  const dirty = inRepo && (status.changedFiles > 0 || status.operationInProgress);
  // Hover opens the menu inside a repository; outside one it opens on click, so the reason it is
  // disabled is available without the pointer passing over the chip on the way elsewhere.
  const open = inRepo ? menuOpen || hovered : menuOpen;

  const filesChanged = status.changedFiles === 1 ? "1 changed file" : `${status.changedFiles} changed files`;
  const counts = status.additions > 0 || status.deletions > 0 ? ` · +${status.additions} −${status.deletions}` : "";
  const branch = status.branch ? ` on ${status.branch}` : "";
  const label = !inRepo
    ? "This folder is not a git repository"
    : status.operationInProgress
      ? `Git operation in progress${branch}`
      : dirty ? `Workspace changes${branch}${counts}` : `Clean tree${branch}`;
  const hint = !inRepo ? "This folder is not a git repository" : dirty ? null : "Nothing to commit";
  const branchHint = `Branch: ${status.branch ?? "unavailable"}`;
  const commitHint = hint ?? `Commit to ${status.branch ?? "current branch"}`;
  const pushHint = hint ?? `${branchHint} · Commit, merge the upstream branch, then push`;
  const previewHint = !inRepo
    ? "This folder is not a git repository"
    : status.changedFiles > 0 ? filesChanged : "No changed files to preview";

  function preview() {
    if (!dirty) return;
    setMenuOpen(false);
    setHovered(false);
    useToolsPanelStore.getState().request("review");
  }

  return (
    <div
      className={`git-chip${inRepo ? "" : " git-chip-no-repo"}`}
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
        aria-label={!inRepo ? "No git repository" : dirty ? `Workspace changes${branch}${counts}` : `Working tree clean${branch}`}
        title={label}
      >
        {sending ? <LoaderCircle className="spin" size={14} /> : <GitBranch size={14} />}
        {!inRepo && <span className="git-chip-branch">No git</span>}
        {inRepo && status.branch && <span className="git-chip-branch">{status.branch}</span>}
        <HeaderDiffstat />
        <ChevronDown size={11} aria-hidden="true" />
      </button>
      {open && (
        <div className="git-chip-menu" role="menu" data-testid="git-chip-menu">
          <button
            type="button"
            role="menuitem"
            data-testid="git-preview"
            disabled={!dirty}
            onClick={preview}
          >
            <Eye size={13} />
            <span>
              <strong>Preview</strong>
              <small>{previewHint}</small>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="git-commit"
            disabled={sending || !dirty}
            onClick={() => void run("/commit")}
          >
            <GitCommitHorizontal size={13} />
            <span>
              <strong>Commit</strong>
              <small>{commitHint}</small>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="git-commit-and-push"
            disabled={sending || !dirty}
            onClick={() => void run("/commit-and-push")}
          >
            <ArrowUpFromLine size={13} />
            <span>
              <strong>Commit and push</strong>
              <small>{pushHint}</small>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
