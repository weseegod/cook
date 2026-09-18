import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { hooksAction, listHooks } from "../../acp/settings-ext";
import { normalizeError } from "../../acp/errors";
import { useCatalogStore } from "../../state/catalog";
import { useSessionStore } from "../../state/session";
import { EmptyState, LoadingState } from "../components/async-state";
import { ToggleSwitch } from "../components/toggle-switch";

/** Settings → Hooks: list + trust/enable via `x.ai/hooks/*`; N-hookev fills the event log. */
export function HooksPanel({ connected }: { connected: boolean }) {
  const sessionId = useSessionStore((state) => state.sessionId);
  const catalogHooks = useCatalogStore((state) => state.hooks);
  const projectTrusted = useCatalogStore((state) => state.hooksProjectTrusted);
  const hookEvents = useCatalogStore((state) => state.hookEvents);
  const setHooks = useCatalogStore((state) => state.setHooks);
  const queryClient = useQueryClient();

  const hooksQuery = useQuery({
    queryKey: ["hooks", sessionId],
    queryFn: async () => {
      if (!sessionId) return { hooks: [], projectTrusted: false };
      const result = await listHooks(sessionId);
      const trusted = result.projectTrusted === true || result.project_trusted === true;
      setHooks(result.hooks ?? [], trusted);
      return { hooks: result.hooks ?? [], projectTrusted: trusted, loadErrors: result.loadErrors ?? result.load_errors ?? [] };
    },
    enabled: connected && Boolean(sessionId),
    retry: 0,
  });

  const hooks = hooksQuery.data?.hooks ?? catalogHooks;
  const trusted = hooksQuery.data?.projectTrusted ?? projectTrusted;
  const loadErrors = hooksQuery.data?.loadErrors ?? [];

  const action = useMutation({
    mutationFn: async (payload: Parameters<typeof hooksAction>[1]) => {
      if (!sessionId) throw new Error("No session");
      return hooksAction(sessionId, payload);
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["hooks"] }),
  });

  return (
    <div className="hooks-panel" data-testid="hooks-panel">
      <div className="settings-actions">
        <button
          className="ghost-button"
          disabled={!connected || !sessionId || action.isPending}
          onClick={() => action.mutate({ type: "trust" })}
          data-testid="hooks-trust"
        >
          <ShieldCheck size={15} /> Trust project
        </button>
        <button
          className="ghost-button"
          disabled={!connected || !sessionId || action.isPending}
          onClick={() => action.mutate({ type: "reload" })}
          data-testid="hooks-reload"
        >
          <RefreshCw size={15} /> Reload
        </button>
      </div>
      <p className="settings-note" data-testid="hooks-trust-status">
        Project hooks: {trusted ? "trusted" : "not trusted"}
      </p>
      {hooksQuery.isLoading && <LoadingState label="Loading hooks" />}
      {hooks.length === 0 && !hooksQuery.isLoading && <EmptyState label="No hooks" detail="Hook directories registered for this session will appear here." />}
      <ul className="skill-list">
        {hooks.map((hook) => {
          const enabled = hook.disabled !== true;
          return (
            <li key={hook.name} data-testid={`hook-${hook.name}`}>
              <div>
                <strong>{hook.name}</strong>
                <small>
                  {hook.event}
                  {hook.matcher ? ` · ${hook.matcher}` : ""}
                  {hook.pinned ? " · pinned" : ""}
                </small>
              </div>
              <div className="skill-toggle">
                <ToggleSwitch
                  checked={enabled}
                  ariaLabel={`Toggle hook ${hook.name}`}
                  disabled={action.isPending || hook.pinned === true || !sessionId}
                  onChange={(next) =>
                    action.mutate(
                      next
                        ? { type: "enable", hook_name: hook.name }
                        : { type: "disable", hook_name: hook.name },
                    )
                  }
                />
              </div>
            </li>
          );
        })}
      </ul>
      {loadErrors.length > 0 && (
        <p className="settings-note security-warning">{loadErrors.join("; ")}</p>
      )}
      {action.isError && (
        <p className="settings-note">{normalizeError(action.error, "The hook action failed")}</p>
      )}
      <h3>Event log</h3>
      {hookEvents.length === 0 ? (
        <EmptyState label="No hook events yet" detail="x.ai/hooks/event and hook annotations show up here." />
      ) : (
        <ul className="hook-event-log" data-testid="hook-event-log">
          {hookEvents.map((entry) => (
            <li key={entry.id}>
              <code>{entry.event}</code>
              <span>{entry.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
