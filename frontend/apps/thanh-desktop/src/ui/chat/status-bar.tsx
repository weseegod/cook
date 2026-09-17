import { Brain, Folder, Gauge } from "lucide-react";
import { acpClient } from "../../acp/client";
import { groupByProvider } from "../../acp/xai";
import { useModelSelection } from "../../state/catalog";
import { useSessionStore } from "../../state/session";

export function StatusBar() {
  const { cwd, usage, planMode } = useSessionStore();
  const { id: selected, known, models } = useModelSelection();
  const tokens = tokenSummary(usage);
  return (
    <div className="statusbar">
      <div className="statusbar-leading">
        <label className="model-select">
        <Gauge size={13} />
        <select
          value={selected}
          disabled={models.length === 0}
          onChange={(event) => void acpClient.setModel(event.target.value).catch(reportError)}
          aria-label="Model"
        >
          {!known && (
            <option value={selected} disabled>
              {models.length === 0 ? "Loading models…" : selected || "Select model"}
            </option>
          )}
          {groupByProvider(models).map(([provider, entries]) => (
            <optgroup key={provider} label={provider}>
              {entries.map((model) => <option key={model.id} value={model.id}>{model.name ?? model.id}</option>)}
            </optgroup>
          ))}
        </select>
        </label>
        <button
        className={planMode ? "active" : ""}
        data-testid="plan-toggle"
        aria-pressed={planMode}
        onClick={() => void acpClient.setPlanMode(!planMode).catch(reportError)}
        >
          <Brain size={13} /> Plan
        </button>
      </div>
      <span className="status-cwd" title={cwd ?? undefined}><Folder size={13} /> {cwd}</span>
      {tokens && <span className="status-usage">{tokens}</span>}
    </div>
  );
}

function reportError(error: unknown) {
  useSessionStore.getState().set({ error: error instanceof Error ? error.message : String(error) });
}

function tokenSummary(usage: Record<string, unknown> | null): string | null {
  const used = Number(usage?.used ?? usage?.totalTokens ?? 0);
  if (!Number.isFinite(used) || used <= 0) return null;
  const size = Number(usage?.size ?? 0);
  const count = new Intl.NumberFormat(undefined, { notation: used > 9999 ? "compact" : "standard" }).format(used);
  if (!Number.isFinite(size) || size <= 0) return `${count} tokens`;
  const percent = Math.min(100, Math.round((used / size) * 100));
  return `${count} / ${new Intl.NumberFormat(undefined, { notation: "compact" }).format(size)} tokens (${percent}%)`;
}
