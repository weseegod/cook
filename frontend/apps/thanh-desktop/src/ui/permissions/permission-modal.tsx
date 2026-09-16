import { ShieldAlert, Terminal, X } from "lucide-react";
import { acpClient } from "../../acp/client";
import { useSessionStore } from "../../state/session";

export function PermissionModal() {
  const pending = useSessionStore((state) => state.pendingPermission);
  if (!pending) return null;
  const tool = pending.request.toolCall;
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal permission-modal" role="dialog" aria-modal="true" aria-labelledby="permission-title">
        <button className="modal-close" onClick={() => void acpClient.answerPermission()} aria-label="Close"><X size={17} /></button>
        <div className="modal-icon warning"><ShieldAlert size={23} /></div>
        <h2 id="permission-title">Permission required</h2>
        <p>Thanh wants to run a tool that can affect your machine or workspace.</p>
        <div className="permission-tool"><Terminal size={16} /><strong>{tool.title ?? tool.kind ?? "Tool call"}</strong></div>
        {Array.isArray(tool.content) && tool.content.length > 0 && <pre>{tool.content.map(readContent).join("\n")}</pre>}
        <div className="modal-actions permission-actions">
          {pending.request.options.map((option) => (
            <button
              key={option.optionId}
              className={option.kind.startsWith("allow") ? "primary-button" : "danger-button"}
              onClick={() => void acpClient.answerPermission(option.optionId)}
            >
              {option.name}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function readContent(content: unknown) {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const item = content as Record<string, unknown>;
    if (typeof item.text === "string") return item.text;
    if (item.content) return readContent(item.content);
  }
  return JSON.stringify(content, null, 2);
}
