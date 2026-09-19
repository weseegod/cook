import { ChevronDown, Copy, FileText, Link2, MoreVertical, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { acpClient } from "../../acp/client";
import { normalizeError } from "../../acp/errors";
import { deletePlanFile, type PlanFileSummary } from "../../acp/plan-files";
import { useSessionStore } from "../../state/session";
import { ConfirmDialog } from "../components/dialog";
import { copyText } from "./clipboard";

/**
 * The header's `plan` chip, carrying the session's plan files.
 *
 * Plan mode allocates one file per planning episode (`<session>/plans/<utc>.md`), so the chip opens
 * a list rather than one document: the current episode is marked, and every row hides a
 * three-dot menu with Copy, Copy file path and Delete. Deleting goes through the agent
 * (`x.ai/session/plans/delete`) — the renderer never touches the filesystem.
 *
 * The conversation's plans are always reachable: the chip stays in the header from the moment a
 * workspace is open, and shows an empty list before the first episode is written. An agent that
 * does not serve the list at all leaves the list empty too, and keeps its older behavior for a
 * parked review: clicking the chip opens the review pane.
 */
export function PlanChip() {
  const files = useSessionStore((state) => state.planFiles);
  const review = useSessionStore((state) => state.planReview);
  const cwd = useSessionStore((state) => state.cwd);
  const [listOpen, setListOpen] = useState(false);
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PlanFileSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!listOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        setListOpen(false);
        setMenuPath(null);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      // Top-down: the confirmation, then the row menu, then the list itself.
      if (pendingDelete) {
        setPendingDelete(null);
        setDeleteError(null);
        return;
      }
      if (menuPath) {
        setMenuPath(null);
        return;
      }
      setListOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [listOpen, menuPath, pendingDelete]);

  const current = files.find((file) => file.active) ?? null;
  // No workspace means no conversation to hang plans on; the welcome screen keeps its clean header.
  if (!cwd) return null;
  // A parked review from an agent that serves no list is the one case the popover cannot show, so
  // the chip falls back to opening the review itself.
  const opensList = files.length > 0 || !review;

  function toggleList() {
    const next = !listOpen;
    setListOpen(next);
    setMenuPath(null);
    // The list is the only surface that knows a plan file appeared, so refresh on open.
    if (next) void acpClient.refreshPlanFiles();
  }

  /** A row opens its plan: the review pane owns the current episode while a review is parked. */
  function openPlan(file: PlanFileSummary) {
    const state = useSessionStore.getState();
    if (file.active && state.planReview) state.setPlanDialogOpen(true);
    else state.setPlanFileView(file);
    setListOpen(false);
    setMenuPath(null);
  }

  async function copyPlan(file: PlanFileSummary) {
    setMenuPath(null);
    const state = useSessionStore.getState();
    if (file.content === null) {
      state.set({ notice: `${file.name} is too large to copy from here. Open it instead.` });
      return;
    }
    try {
      await copyText(file.content);
      state.set({ notice: `Copied ${file.name}` });
    } catch (error) {
      state.set({ error: normalizeError(error, "Could not copy the plan") });
    }
  }

  async function copyPlanPath(file: PlanFileSummary) {
    setMenuPath(null);
    const state = useSessionStore.getState();
    try {
      await copyText(file.path);
      state.set({ notice: `Copied ${file.path}` });
    } catch (error) {
      state.set({ error: normalizeError(error, "Could not copy the path") });
    }
  }

  async function removePlan() {
    const file = pendingDelete;
    const { sessionId, cwd } = useSessionStore.getState();
    if (!file || deleting || !sessionId || !cwd) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deletePlanFile({ sessionId, cwd, path: file.path });
      setPendingDelete(null);
      await acpClient.refreshPlanFiles();
      useSessionStore.getState().set({ notice: `Deleted ${file.name}` });
    } catch (error) {
      setDeleteError(normalizeError(error, "Could not delete the plan"));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="plan-chip-root" ref={root}>
      <button
        type="button"
        className="plan-chip"
        data-testid="plan-chip"
        title={listOpen ? "Hide plans" : "Plans in this conversation"}
        aria-haspopup="menu"
        aria-expanded={listOpen}
        onClick={() => (opensList ? toggleList() : useSessionStore.getState().setPlanDialogOpen(true))}
      >
        <FileText size={12} aria-hidden="true" />
        <span className="plan-chip-name">{current?.name ?? "plan"}</span>
        {opensList && <ChevronDown size={12} aria-hidden="true" />}
      </button>
      {listOpen && (
        <div className="plan-menu" role="menu" data-testid="plan-menu">
          {files.length === 0 && (
            <div className="plan-menu-empty" data-testid="plan-menu-empty">
              No plans in this conversation yet
            </div>
          )}
          {files.map((file) => (
            <div
              key={file.path}
              className={`plan-menu-row${file.active ? " active" : ""}`}
              data-testid={`plan-file-row-${file.name}`}
            >
              <button
                type="button"
                className="plan-menu-open"
                data-testid={`plan-file-open-${file.name}`}
                title={file.path}
                onClick={() => openPlan(file)}
              >
                <span className="plan-menu-name">{file.name}</span>
                <span className="plan-menu-meta">
                  {file.active && (
                    <span className="plan-menu-badge" data-testid="plan-file-current">
                      current
                    </span>
                  )}
                  <span>{planFileMeta(file)}</span>
                </span>
              </button>
              <button
                type="button"
                className="plan-menu-dots"
                data-testid={`plan-file-actions-${file.name}`}
                aria-label={`Actions for ${file.name}`}
                aria-haspopup="menu"
                aria-expanded={menuPath === file.path}
                onClick={() => setMenuPath(menuPath === file.path ? null : file.path)}
              >
                <MoreVertical size={14} />
              </button>
              {menuPath === file.path && (
                <div className="plan-row-menu" role="menu" data-testid={`plan-file-menu-${file.name}`}>
                  <button type="button" role="menuitem" data-testid="plan-file-copy" onClick={() => void copyPlan(file)}>
                    <Copy size={13} />
                    <span>Copy</span>
                  </button>
                  <button type="button" role="menuitem" data-testid="plan-file-copy-path" onClick={() => void copyPlanPath(file)}>
                    <Link2 size={13} />
                    <span>Copy file path</span>
                  </button>
                  <div className="plan-row-menu-separator" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    className="plan-row-menu-danger"
                    data-testid="plan-file-delete"
                    disabled={!file.deletable}
                    title={file.deletable
                      ? `Delete ${file.name}`
                      : "The current plan cannot be deleted while plan mode is on"}
                    onClick={() => {
                      setMenuPath(null);
                      setPendingDelete(file);
                    }}
                  >
                    <Trash2 size={13} />
                    <span>Delete</span>
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {pendingDelete && (
        <ConfirmDialog
          title="Delete plan"
          description={`Delete ${pendingDelete.name}? The file is removed from this session's plans.`}
          confirmLabel="Delete plan"
          confirmTestId="plan-delete-confirm"
          danger
          busy={deleting}
          error={deleteError}
          onCancel={() => {
            setPendingDelete(null);
            setDeleteError(null);
          }}
          onConfirm={() => void removePlan()}
        />
      )}
    </div>
  );
}

/** Size and last write for the row's second line; the file name carries the creation time. */
function planFileMeta(file: PlanFileSummary): string {
  const size = file.sizeBytes < 1024 ? `${file.sizeBytes} B` : `${Math.round(file.sizeBytes / 1024)} KB`;
  if (file.modifiedMs <= 0) return size;
  const written = new Date(file.modifiedMs);
  if (Number.isNaN(written.valueOf())) return size;
  const stamp = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(written);
  return `${size} · ${stamp}`;
}
