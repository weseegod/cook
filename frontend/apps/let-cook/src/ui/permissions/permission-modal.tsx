import { ShieldAlert, Terminal, X } from "lucide-react";
import { useEffect } from "react";
import { acpClient } from "../../acp/client";
import { useSessionStore } from "../../state/session";
import { InfoTip } from "../components/info-tip";

export function PermissionModal() {
  const pending = useSessionStore((state) => state.pendingPermission);
  useEffect(() => {
    if (!pending) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w")) {
        event.preventDefault();
        void acpClient.answerPermission();
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && /^[1-9]$/.test(event.key)) {
        const option = pending.request.options[Number(event.key) - 1];
        if (option) {
          event.preventDefault();
          void acpClient.answerPermission(option.optionId);
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pending]);
  if (!pending) return null;
  const tool = pending.request.toolCall;
  return (
    <section className="inline-interaction inline-permission" data-testid="inline-permission" aria-live="polite">
      <header className="inline-interaction-header">
        <div className="inline-interaction-icon warning"><ShieldAlert size={16} /></div>
        <div>
          <strong>Permission required <InfoTip label="Permission required">Cook wants to run a tool that can affect your machine or workspace.</InfoTip></strong>
          <span>Choose an option to continue</span>
        </div>
        <button className="icon-button" onClick={() => void acpClient.answerPermission()} aria-label="Reject permission"><X size={15} /></button>
      </header>
      <div className="permission-tool"><Terminal size={14} /><strong>{tool.title ?? tool.kind ?? "Tool call"}</strong></div>
      {Array.isArray(tool.content) && tool.content.length > 0 && <pre className="permission-content">{tool.content.map(readContent).join("\n")}</pre>}
      <div className="permission-actions">
        {pending.request.options.map((option, index) => (
          <button key={option.optionId} className={option.kind.startsWith("allow") ? "primary-button" : "danger-button"} onClick={() => void acpClient.answerPermission(option.optionId)}>
            <kbd>{index + 1}</kbd>{option.name}
          </button>
        ))}
      </div>
    </section>
  );
}

function readContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const item = content as Record<string, unknown>;
    if (typeof item.text === "string") return item.text;
    if (item.content) return readContent(item.content);
  }
  return JSON.stringify(content, null, 2);
}
