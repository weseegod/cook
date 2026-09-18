import { FolderOpen } from "lucide-react";
import { acpClient } from "../../acp/client";
import { readLocal } from "../storage";

export function Welcome({ onChooseWorkspace }: { onChooseWorkspace: () => void }) {
  const recent = recentWorkspaces();
  return (
    <section className="welcome">
      <div className="welcome-mark">
        <img src="/logo.svg" alt="Let Cook" width={40} height={40} />
      </div>
      <h1>Let Cook</h1>
      <p>Choose a folder to start.</p>
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
    </section>
  );
}

function recentWorkspaces(): string[] {
  try {
    return JSON.parse(readLocal("recentWorkspaces") ?? "[]") as string[];
  } catch {
    return [];
  }
}
