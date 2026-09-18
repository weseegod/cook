import { useMutation, useQuery } from "@tanstack/react-query";
import { Brain, FileText, Sparkles } from "lucide-react";
import { useState } from "react";
import { flushMemory, forgetMemory, readProjectFile, rewriteMemory } from "../../acp/extensions";
import { memoryFileSize, type MemoryFileView } from "../../acp/settings-ext";
import { useCatalogStore } from "../../state/catalog";
import { useSessionStore } from "../../state/session";
import { EmptyState, LoadingState } from "../components/async-state";

function fileLabel(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Settings → Memory: list files from U-memf, open via `x.ai/fs/read_file`.
 * Does not write MEMORY.md here — only flush / rewrite / forget (agent ops).
 */
export function MemoryBrowserPanel({ connected }: { connected: boolean }) {
  const sessionId = useSessionStore((state) => state.sessionId);
  const memoryFiles = useCatalogStore((state) => state.memoryFiles);
  const memoryEnabled = useCatalogStore((state) => state.memoryEnabled);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const preview = useQuery({
    queryKey: ["memory-file", activePath, sessionId],
    queryFn: () => readProjectFile(sessionId ?? undefined, activePath!),
    enabled: connected && Boolean(activePath),
    retry: 0,
  });

  const run = useMutation({
    mutationFn: async (action: "flush" | "rewrite" | "forget") => {
      if (action === "flush") return flushMemory();
      if (action === "rewrite") return rewriteMemory();
      return forgetMemory();
    },
    onSuccess: (_result, action) => setStatus(`${action} requested`),
    onError: (error) => setStatus(error instanceof Error ? error.message : String(error)),
  });

  const grouped = groupBySource(memoryFiles);

  return (
    <div className="memory-panel" data-testid="memory-browser">
      <div className="settings-actions">
        <button className="ghost-button" disabled={!connected || run.isPending} onClick={() => run.mutate("flush")} data-testid="memory-flush">
          <Brain size={15} /> Flush
        </button>
        <button className="ghost-button" disabled={!connected || run.isPending} onClick={() => run.mutate("rewrite")}>
          <Sparkles size={15} /> Rewrite
        </button>
        <button className="ghost-button" disabled={!connected || run.isPending} onClick={() => run.mutate("forget")}>
          Forget
        </button>
      </div>
      {!memoryEnabled && <p className="settings-note">Memory is off for this session.</p>}
      {memoryFiles.length === 0 ? (
        <EmptyState
          label="No memory files yet"
          detail="Run /memory to list files the agent has stored for this workspace."
        />
      ) : (
        <div className="memory-browser-layout">
          <ul className="skill-list memory-file-list" data-testid="memory-file-list">
            {grouped.map(([source, files]) => (
              <li key={source} className="memory-source-group">
                <strong className="memory-source-label">{source}</strong>
                <ul className="skill-list">
                  {files.map((file) => (
                    <li key={file.path}>
                      <button
                        type="button"
                        className={file.path === activePath ? "memory-file-btn active" : "memory-file-btn"}
                        data-testid={`memory-file-${fileLabel(file.path)}`}
                        onClick={() => setActivePath(file.path)}
                      >
                        <span>
                          <strong>{fileLabel(file.path)}</strong>
                          <small>
                            {formatBytes(memoryFileSize(file))}
                            {file.generated ? " · index" : ""}
                          </small>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <div className="memory-preview">
            {activePath ? (
              <>
                <p className="settings-path"><code>{activePath}</code></p>
                {preview.isLoading && <LoadingState label="Loading file" />}
                {preview.isError && <EmptyState label="Could not read file" detail="The agent refused or the path is gone." />}
                {preview.isSuccess && (
                  <pre className="settings-textarea memory-preview-body" data-testid="memory-preview">
                    {preview.data.content || "(empty)"}
                  </pre>
                )}
              </>
            ) : (
              <EmptyState label="Select a file" detail="MEMORY.md and notes open read-only through the agent filesystem." />
            )}
          </div>
        </div>
      )}
      {status && (
        <p className="settings-note" data-testid="memory-status">
          <FileText size={13} /> {status}
        </p>
      )}
    </div>
  );
}

function groupBySource(files: MemoryFileView[]): Array<[string, MemoryFileView[]]> {
  const order = ["global", "workspace", "session"];
  const map = new Map<string, MemoryFileView[]>();
  for (const file of files) {
    const key = file.source || "workspace";
    const list = map.get(key) ?? [];
    list.push(file);
    map.set(key, list);
  }
  return [...map.entries()].sort((a, b) => {
    const ai = order.indexOf(a[0]);
    const bi = order.indexOf(b[0]);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
}
