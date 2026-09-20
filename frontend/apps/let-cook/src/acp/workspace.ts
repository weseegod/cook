import { invoke } from "@tauri-apps/api/core";

export type WorkspaceEntryKind = "file" | "directory";

export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: WorkspaceEntryKind;
  size: number | null;
}

/** Flat path row from `workspace_index` — fuzzy ranking runs in the renderer. */
export interface WorkspaceIndexEntry {
  path: string;
  kind: WorkspaceEntryKind;
}

export interface FilePreview {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
  binary: boolean;
}

export type ReviewStatus = "added" | "modified" | "deleted" | "renamed" | "conflicted" | "untracked";

export interface ReviewFile {
  path: string;
  status: ReviewStatus;
  additions: number;
  deletions: number;
  diff: string;
}

export interface ReviewSnapshot {
  base: "HEAD";
  isGitRepo: boolean;
  branch: string | null;
  files: ReviewFile[];
  additions: number;
  deletions: number;
}

const isTauri = () => "__TAURI_INTERNALS__" in window;
const isMock = () => !isTauri() && import.meta.env.VITE_MOCK_ACP === "1";

export async function listWorkspace(relativePath = ""): Promise<WorkspaceEntry[]> {
  if (isTauri()) return invoke<WorkspaceEntry[]>("workspace_list", { relativePath });
  if (isMock()) return (await import("./mock-transport")).mockWorkspaceList(relativePath);
  throw new Error("Workspace browsing requires the Let Cook app");
}

/** Flat workspace inventory for `@` path search. `hidden` includes gitignored and dotfiles. */
export async function indexWorkspace(hidden = false): Promise<WorkspaceIndexEntry[]> {
  if (isTauri()) return invoke<WorkspaceIndexEntry[]>("workspace_index", { hidden });
  if (isMock()) return (await import("./mock-transport")).mockWorkspaceIndex(hidden);
  throw new Error("Workspace indexing requires the Let Cook app");
}

export async function readWorkspaceFile(relativePath: string): Promise<FilePreview> {
  if (isTauri()) return invoke<FilePreview>("workspace_read_file", { relativePath });
  if (isMock()) return (await import("./mock-transport")).mockWorkspaceReadFile(relativePath);
  throw new Error("Workspace file preview requires the Let Cook app");
}

export async function loadWorkspaceReview(): Promise<ReviewSnapshot> {
  if (isTauri()) return invoke<ReviewSnapshot>("workspace_review");
  if (isMock()) return (await import("./mock-transport")).mockWorkspaceReview();
  throw new Error("Workspace review requires the Let Cook app");
}

/** Dirty-tree summary for the header git chip: counts only, never per-file patches. */
export interface GitStatusSummary {
  isGitRepo: boolean;
  branch: string | null;
  changedFiles: number;
  additions: number;
  deletions: number;
  operationInProgress: boolean;
}

export async function loadGitStatus(): Promise<GitStatusSummary> {
  if (isTauri()) return invoke<GitStatusSummary>("workspace_git_status");
  if (isMock()) return (await import("./mock-transport")).mockGitStatus();
  throw new Error("Git status requires the Let Cook app");
}

export async function openWorkspacePath(relativePath: string): Promise<void> {
  if (isTauri()) {
    await invoke("workspace_open", { relativePath });
    return;
  }
  if (isMock()) return;
  throw new Error("Opening workspace paths requires the Let Cook app");
}

export function fileExtension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "text";
}

export function formatBytes(size: number | null | undefined): string {
  if (size == null) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
