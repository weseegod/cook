import { Check, CheckCircle2, Cpu, LogIn, LogOut, Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
import { mergedProviderStatus } from "../../../acp/provider-presets";
import type { ModelSummary } from "../../../acp/xai";
import { ProviderLogo } from "./provider-logo";
import { formatTokens, type ProviderRow } from "./provider-rows";

interface ProviderCardProps {
  row: ProviderRow;
  selectedModel: string;
  onAddModel: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onConnect?: () => void;
  onSignOut?: () => void;
  onEditModel: (model: ModelSummary) => void;
  onRemoveModel: (model: ModelSummary) => void;
}

/** One provider's card: status badge, connection actions, and its model list. */
export function ProviderCard({
  row,
  selectedModel,
  onAddModel,
  onEdit,
  onRemove,
  onConnect,
  onSignOut,
  onEditModel,
  onRemoveModel,
}: ProviderCardProps) {
  const status = mergedProviderStatus(row.provider, row.oauthConnected);
  const label = row.provider?.name ?? row.preset.label;
  const connected = status.tone === "ok";
  return (
    <article className="provider-model-card" data-testid={`provider-row-${row.preset.id}`}>
      <header className="provider-model-heading">
        <div className="provider-row-main">
          <div className="provider-title-line">
            <ProviderLogo id={row.preset.id} size={22} label={label} />
            <strong>{label}</strong>
            <span className={`badge badge-${status.tone}`}>
              {status.tone === "ok" ? <CheckCircle2 size={12} /> : <TriangleAlert size={12} />} {status.label}
            </span>
          </div>
          <small>{row.oauthConnected ? row.oauthEmail ?? "Cook account" : row.provider?.baseUrl ?? row.preset.baseUrl ?? "Provider endpoint"}</small>
        </div>
        <div className="provider-header-actions">
          {connected ? (
            <>
              {row.provider && (
                <button
                  className="ghost-button provider-header-model-button"
                  aria-label={`Add model to ${row.preset.id}`}
                  data-testid={`provider-add-model-${row.preset.id}`}
                  onClick={onAddModel}
                >
                  <Plus size={13} /> Add model
                </button>
              )}
              <button className="ghost-button provider-header-model-button" data-testid={`provider-edit-${row.preset.id}`} onClick={onEdit}>
                <Pencil size={13} /> Edit
              </button>
              {row.oauthConnected && onSignOut && (
                <button
                  className="ghost-button provider-header-model-button"
                  data-testid={`provider-signout-${row.preset.id}`}
                  onClick={onSignOut}
                >
                  <LogOut size={13} /> Sign out
                </button>
              )}
              {row.provider && (
                <button
                  className="ghost-button danger-ghost-button provider-header-model-button"
                  data-testid={`provider-remove-${row.preset.id}`}
                  onClick={onRemove}
                >
                  <Trash2 size={13} /> Remove
                </button>
              )}
            </>
          ) : (
            <button
              className="primary-button provider-connect-button"
              data-testid={`provider-connect-${row.preset.id}`}
              onClick={onConnect ?? onEdit}
            >
              <LogIn size={14} /> Connect
            </button>
          )}
        </div>
      </header>

      <div className="provider-model-content">
        <div className="provider-models-summary">
          <div className="provider-models-label">
            <Cpu size={14} /><strong>Models</strong>
            <small>{row.models.length === 0 ? "none configured" : `${row.models.length} configured`}</small>
          </div>
          {row.models.length > 0 ? (
            <ul className="model-list">
              {row.models.map((model) => (
                <li key={model.id} data-testid={`model-row-${model.id}`}>
                  <div className="model-row-copy"><strong title={model.name ?? model.id}>{model.name ?? model.id}</strong><code title={model.id}>{model.id}</code></div>
                  <div className="model-row-meta">
                    <span title="Context window">Context {formatTokens(model.contextWindow)}</span>
                    <span title="Maximum output tokens">Output {formatTokens(model.maxCompletionTokens)}</span>
                    <span title="Accepted input">Input {model.inputModalities?.join(" + ") || "—"}</span>
                    {model.id === selectedModel && <Check className="model-selected-check" size={13} aria-label="Selected" />}
                    <button
                      className="icon-button model-edit-button"
                      aria-label={`Edit model ${model.id}`}
                      onClick={() => onEditModel(model)}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      className="icon-button model-delete-button"
                      aria-label={`Remove model ${model.id}`}
                      data-testid={`model-remove-${model.id}`}
                      onClick={() => onRemoveModel(model)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="provider-no-models">
              {connected
                ? "No models yet. Add one to make it selectable in chat."
                : "Connect this provider to choose models."}
            </p>
          )}
        </div>
      </div>
    </article>
  );
}
