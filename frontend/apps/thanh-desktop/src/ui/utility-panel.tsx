import { Activity, ClipboardCheck, Copy, Eye, FileCode2, Folder, FolderOpen, FolderTree, PanelRightClose, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  fileExtension,
  formatBytes,
  listWorkspace,
  loadWorkspaceReview,
  openWorkspacePath,
  readWorkspaceFile,
  type FilePreview,
  type ReviewFile,
  type ReviewSnapshot,
  type WorkspaceEntry,
} from "../acp/workspace";
import { GIT_HEAD_CHANGED_EVENT, useArtifactStore } from "../state/artifacts";
import { useActivityStore } from "../state/activity";
import { ActivityPanel } from "./activity/activity-panel";
import { ArtifactsPanel } from "./artifacts-panel";
import { copyText } from "./chat/clipboard";

type UtilityId = "review" | "files" | "activity" | "preview";
type PanelView = "launcher" | UtilityId;

const UTILITIES: Array<{ id: UtilityId; label: string; shortcut?: string; icon: typeof ClipboardCheck }> = [
  { id: "review", label: "Review", shortcut: "⌃⇧G", icon: ClipboardCheck },
  { id: "files", label: "Files", shortcut: "⌘P", icon: FolderOpen },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "preview", label: "Preview", icon: Eye },
];

export function UtilityPanel({ onClose, initialView }: { onClose: () => void; initialView?: UtilityId }) {
  const [view, setView] = useState<PanelView>(initialView ?? "launcher");
  const panelNonce = useActivityStore((state) => state.panelNonce);
  const panelTarget = useActivityStore((state) => state.panelTarget);
  const artifactEpoch = useArtifactStore((state) => state.openEpoch);

  useEffect(() => {
    if (panelTarget === "activity") {
      setView("activity");
      useActivityStore.getState().clearPanelTarget();
    }
  }, [panelNonce, panelTarget]);

  useEffect(() => {
    if (artifactEpoch > 0) setView("preview");
  }, [artifactEpoch]);

  useEffect(() => {
    if (initialView) setView(initialView);
  }, [initialView]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable=\"true\"]")) return;
      const key = event.key.toLowerCase();
      if (event.ctrlKey && event.shiftKey && key === "g") {
        event.preventDefault();
        setView("review");
      } else if ((event.metaKey || event.ctrlKey) && key === "p") {
        event.preventDefault();
        setView("files");
      } else if (event.key === "Escape" && view !== "launcher") {
        event.preventDefault();
        setView("launcher");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [view]);

  return (
    <aside className="utility-panel" aria-label="Workspace tools" data-testid="utility-panel">
      <button type="button" className="icon-button utility-panel-close" onClick={onClose} aria-label="Close tools panel" title="Close tools panel"><PanelRightClose size={16} /></button>
      {view === "launcher" ? (
        <UtilityLauncher onSelect={setView} />
      ) : (
        <div className="utility-content">
          <div className="utility-content-header">
            <button type="button" className="utility-back" onClick={() => setView("launcher")}><X size={13} /> Tools</button>
            <strong>{UTILITIES.find((entry) => entry.id === view)?.label}</strong>
          </div>
          {view === "review" && <ReviewView />}
          {view === "files" && <FilesView />}
          {view === "activity" && <ActivityPanel />}
          {view === "preview" && <ArtifactsPanel />}
        </div>
      )}
    </aside>
  );
}

function UtilityLauncher({ onSelect }: { onSelect: (view: PanelView) => void }) {
  return (
    <nav className="utility-list" aria-label="Workspace tools">
      {UTILITIES.map((entry) => {
        const EntryIcon = entry.icon;
        return (
          <button
            key={entry.id}
            type="button"
            className=""
            onClick={() => onSelect(entry.id)}
            title={entry.label}
          >
            <EntryIcon size={15} />
            <span>{entry.label}</span>
            {entry.shortcut && <kbd>{entry.shortcut}</kbd>}
          </button>
        );
      })}
    </nav>
  );
}

function ReviewView() {
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void loadWorkspaceReview()
      .then((next) => {
        if (cancelled) return;
        setSnapshot(next);
        setSelectedPath((current) => current && next.files.some((file) => file.path === current) ? current : next.files[0]?.path ?? null);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [refresh]);

  useEffect(() => {
    const onGitHead = () => setRefresh((value) => value + 1);
    window.addEventListener(GIT_HEAD_CHANGED_EVENT, onGitHead);
    return () => window.removeEventListener(GIT_HEAD_CHANGED_EVENT, onGitHead);
  }, []);

  const selected = snapshot?.files.find((file) => file.path === selectedPath) ?? null;
  return (
    <section className="review-view" data-testid="review-view">
      <div className="utility-view-actions">
        <span>{snapshot?.branch ? `${snapshot.branch} · ${snapshot.base}` : snapshot?.base ?? "HEAD"}</span>
        <button type="button" className="text-button utility-refresh" onClick={() => setRefresh((value) => value + 1)} disabled={loading} aria-label="Refresh review"><RefreshCw size={12} /> Refresh</button>
      </div>
      {loading && <div className="utility-state" role="status">Loading changes…</div>}
      {error && <div className="utility-state utility-state-error" role="alert">{error}</div>}
      {!loading && !error && snapshot && !snapshot.isGitRepo && <div className="utility-state">This workspace is not a Git repository.</div>}
      {!loading && !error && snapshot?.isGitRepo && snapshot.files.length === 0 && <div className="utility-state">No changes compared with HEAD.</div>}
      {!loading && !error && snapshot?.isGitRepo && snapshot.files.length > 0 && (
        <>
          <div className="review-summary"><strong>{snapshot.files.length} files</strong><span className="review-additions">+{snapshot.additions}</span><span className="review-deletions">−{snapshot.deletions}</span></div>
          <div className="review-file-list" role="list" aria-label="Changed files">
            {snapshot.files.map((file) => <ReviewFileRow key={file.path} file={file} selected={file.path === selectedPath} onSelect={() => setSelectedPath(file.path)} />)}
          </div>
          {selected && <DiffPreview file={selected} />}
        </>
      )}
    </section>
  );
}

function ReviewFileRow({ file, selected, onSelect }: { file: ReviewFile; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={`review-file-row${selected ? " selected" : ""}`} onClick={onSelect} role="listitem" aria-label={`${file.status} ${file.path}`}>
      <FileCode2 size={13} />
      <span className="utility-path">{file.path}</span>
      <span className={`review-status review-status-${file.status}`}>{file.status}</span>
      <span className="review-counts"><span className="review-additions">+{file.additions}</span><span className="review-deletions">−{file.deletions}</span></span>
    </button>
  );
}

function DiffPreview({ file }: { file: ReviewFile }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await copyText(file.diff);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch { setCopied(false); }
  }
  return (
    <div className="utility-preview diff-preview" data-testid="diff-preview">
      <div className="utility-preview-header"><strong>{file.path}</strong><button type="button" className="text-button" onClick={() => void copy()}><Copy size={12} /> {copied ? "Copied" : "Copy"}</button></div>
      <pre>{file.diff.split("\n").map((line, index) => <span key={`${index}-${line}`} className={line.startsWith("+") && !line.startsWith("+++") ? "diff-add" : line.startsWith("-") && !line.startsWith("---") ? "diff-remove" : ""}>{line}{"\n"}</span>)}</pre>
    </div>
  );
}

function FilesView() {
  const [entries, setEntries] = useState<Record<string, WorkspaceEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [refresh, setRefresh] = useState(0);
  const previewRequest = useRef(0);

  useEffect(() => {
    setEntries({});
    setExpanded(new Set());
    setSelectedPath(null);
    setPreview(null);
    void loadDirectory("");
    // The view is recreated when switching tools, so this is intentionally a root refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  async function loadDirectory(path: string) {
    setLoadingPaths((current) => new Set(current).add(path));
    setError(null);
    try {
      const next = await listWorkspace(path);
      setEntries((current) => ({ ...current, [path]: next }));
    } catch (reason: unknown) {
      setError(errorMessage(reason));
    } finally {
      setLoadingPaths((current) => { const next = new Set(current); next.delete(path); return next; });
    }
  }

  async function selectFile(path: string) {
    const request = ++previewRequest.current;
    setSelectedPath(path);
    setPreview(null);
    setError(null);
    try {
      const next = await readWorkspaceFile(path);
      if (request === previewRequest.current) setPreview(next);
    } catch (reason: unknown) {
      if (request === previewRequest.current) setError(errorMessage(reason));
    }
  }

  async function toggleDirectory(path: string) {
    const isExpanded = expanded.has(path);
    setExpanded((current) => { const next = new Set(current); if (isExpanded) next.delete(path); else next.add(path); return next; });
    if (!isExpanded && !entries[path]) await loadDirectory(path);
  }

  const rootEntries = entries[""] ?? [];
  return (
    <section className="files-view" data-testid="files-view">
      <div className="utility-view-actions"><span><FolderTree size={13} /> Workspace</span><button type="button" className="text-button utility-refresh" onClick={() => setRefresh((value) => value + 1)} disabled={loadingPaths.size > 0} aria-label="Refresh files"><RefreshCw size={12} /> Refresh</button></div>
      {error && <div className="utility-state utility-state-error" role="alert">{error}</div>}
      <div className="file-tree" role="tree" aria-label="Workspace files">
        {loadingPaths.has("") && <div className="utility-state">Loading files…</div>}
        {!loadingPaths.has("") && rootEntries.length === 0 && <div className="utility-state">No files in this workspace.</div>}
        {rootEntries.map((entry) => <TreeEntry key={entry.path} entry={entry} depth={0} entries={entries} expanded={expanded} loadingPaths={loadingPaths} selectedPath={selectedPath} onToggle={toggleDirectory} onSelect={selectFile} />)}
      </div>
      {preview && <FilePreviewView preview={preview} />}
    </section>
  );
}

function TreeEntry({ entry, depth, entries, expanded, loadingPaths, selectedPath, onToggle, onSelect }: { entry: WorkspaceEntry; depth: number; entries: Record<string, WorkspaceEntry[]>; expanded: Set<string>; loadingPaths: Set<string>; selectedPath: string | null; onToggle: (path: string) => Promise<void>; onSelect: (path: string) => Promise<void> }) {
  const isDirectory = entry.kind === "directory";
  const isExpanded = expanded.has(entry.path);
  return (
    <div role="treeitem" aria-expanded={isDirectory ? isExpanded : undefined}>
      <button type="button" className={`file-tree-row${selectedPath === entry.path ? " selected" : ""}`} style={{ paddingLeft: `${8 + depth * 14}px` }} onClick={() => isDirectory ? void onToggle(entry.path) : void onSelect(entry.path)}>
        {isDirectory ? (isExpanded ? <FolderOpen size={13} /> : <Folder size={13} />) : <FileCode2 size={13} />}
        <span className="utility-path">{entry.name}</span>
        {!isDirectory && <small>{formatBytes(entry.size)}</small>}
      </button>
      {isDirectory && isExpanded && loadingPaths.has(entry.path) && <div className="file-tree-loading" style={{ paddingLeft: `${22 + depth * 14}px` }}>Loading…</div>}
      {isDirectory && isExpanded && entries[entry.path]?.map((child) => <TreeEntry key={child.path} entry={child} depth={depth + 1} entries={entries} expanded={expanded} loadingPaths={loadingPaths} selectedPath={selectedPath} onToggle={onToggle} onSelect={onSelect} />)}
    </div>
  );
}

function FilePreviewView({ preview }: { preview: FilePreview }) {
  const label = useMemo(() => `${fileExtension(preview.path)} · ${formatBytes(preview.size)}`, [preview.path, preview.size]);
  return (
    <div className="utility-preview file-preview" data-testid="file-preview">
      <div className="utility-preview-header"><strong>{preview.path}</strong><span>{label}</span></div>
      {preview.binary ? <div className="utility-state">Binary file preview is unavailable.</div> : <pre><code>{preview.content}</code></pre>}
      {preview.truncated && <div className="utility-preview-note">Preview truncated at 512 KB.</div>}
      {!preview.binary && <button type="button" className="text-button" onClick={() => void openWorkspacePath(preview.path).catch(() => undefined)}><FolderOpen size={12} /> Open externally</button>}
    </div>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
