import { useQuery } from "@tanstack/react-query";
import { Brain, Folder, Gauge } from "lucide-react";
import { acpClient } from "../../acp/client";
import { useSessionStore } from "../../state/session";

export function StatusBar() {
  const { cwd, modelId, sessionId, usage, planMode } = useSessionStore();
  const models = useQuery({ queryKey: ["models"], queryFn: () => acpClient.xai.listModels() });
  const tokens = tokenSummary(usage);
  return (
    <div className="statusbar">
      <label className="model-select">
        <Gauge size={13} />
        <select
          value={modelId ?? ""}
          disabled={!sessionId}
          onChange={(event) => void acpClient.setModel(event.target.value)}
          aria-label="Model"
        >
          <option value="" disabled>{models.isLoading ? "Loading models…" : "Select model"}</option>
          {models.data?.map((model) => <option key={model.id} value={model.id}>{model.name ?? model.id}</option>)}
        </select>
      </label>
      {planMode && <button onClick={() => void acpClient.togglePlan(false)}><Brain size={13} /> Plan</button>}
      <span className="status-cwd" title={cwd ?? undefined}><Folder size={13} /> {cwd}</span>
      {tokens && <span>{tokens}</span>}
    </div>
  );
}

function tokenSummary(usage: Record<string, unknown> | null): string | null {
  if (!usage) return null;
  const total = Number(usage.totalTokens ?? usage.total_tokens ?? usage.tokens ?? 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  return `${new Intl.NumberFormat(undefined, { notation: total > 9999 ? "compact" : "standard" }).format(total)} tokens`;
}
