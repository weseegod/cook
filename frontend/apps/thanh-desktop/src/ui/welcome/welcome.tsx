import { FolderOpen, MessageSquareCode, ShieldCheck, TerminalSquare } from "lucide-react";
import { acpClient } from "../../acp/client";

export function Welcome({ onChooseWorkspace }: { onChooseWorkspace: () => void }) {
  const recent = recentWorkspaces();
  return (
    <section className="welcome">
      <div className="welcome-mark"><MessageSquareCode size={32} /></div>
      <h1>Build with Thanh</h1>
      <p>Choose a folder, then chat with the same agent and sessions used by the Thanh CLI.</p>
      <button className="primary-button welcome-open" onClick={onChooseWorkspace}>
        <FolderOpen size={18} /> Open workspace
      </button>
      {recent.length > 0 && (
        <div className="recent-workspaces">
          <span className="eyebrow">Recent workspaces</span>
          {recent.map((path) => (
            <button key={path} onClick={() => void acpClient.connect(path)}>
              <FolderOpen size={15} /><span>{path}</span>
            </button>
          ))}
        </div>
      )}
      <div className="welcome-notes">
        <span><ShieldCheck size={15} /> Workspace trust and permissions stay explicit</span>
        <span><TerminalSquare size={15} /> Uses your installed <code>thanh agent stdio</code></span>
      </div>
    </section>
  );
}

function recentWorkspaces(): string[] {
  try {
    return JSON.parse(localStorage.getItem("thanh.recentWorkspaces") ?? "[]") as string[];
  } catch {
    return [];
  }
}
