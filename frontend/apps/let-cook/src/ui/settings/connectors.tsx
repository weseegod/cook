import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, KeyRound, Plus, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  deleteConnector,
  listConnectors,
  mcpAuthStatus,
  mcpAuthTrigger,
  mcpSetup,
  serverEnabled,
  serverTransportLabel,
  toggleConnector,
  toggleConnectorTool,
  upsertConnector,
  type McpServerView,
} from "../../acp/extensions";
import { normalizeError } from "../../acp/errors";
import { acpClient } from "../../acp/client";
import { mergeMcpCatalog } from "../../acp/mcp-servers";
import { useCatalogStore } from "../../state/catalog";
import { useSessionStore } from "../../state/session";
import { EmptyState, ErrorState, LoadingState } from "../components/async-state";
import { ConfirmDialog } from "../components/dialog";
import { ToggleSwitch } from "../components/toggle-switch";
import {
  connectorEligibleCount,
  connectorEnabledCount,
  groupConnectors,
  isManagedGatewayServer,
  type ConnectorServerGroup,
} from "./connectors-groups";
import { SettingsGroupHeader } from "./group-header";

/** Settings → Connectors: the agent's MCP servers, tools, auth/setup, and add/toggle/delete. */
export function ConnectorsPanel({ connected, onDirtyChange }: { connected: boolean; onDirtyChange?: (dirty: boolean) => void }) {
  const sessionId = useSessionStore((state) => state.sessionId);
  const cwd = useSessionStore((state) => state.cwd);
  const mcpServers = useCatalogStore((state) => state.mcpServers);
  const setMcpServers = useCatalogStore((state) => state.setMcpServers);
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState<"stdio" | "http" | null>(null);
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [args, setArgs] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [authNote, setAuthNote] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [setupFor, setSetupFor] = useState<string | null>(null);
  const [setupValues, setSetupValues] = useState<Record<string, string>>({});
  const [sessionLoading, setSessionLoading] = useState(false);
  /** Per-connector groups the user folded shut. Groups start expanded. */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());

  // Tool lists live on the session's MCP pool, so a session must exist before the agent can
  // annotate `session.tools`.
  useEffect(() => {
    if (!connected || !cwd || sessionId) return;
    let cancelled = false;
    setSessionLoading(true);
    void acpClient.ensureSession()
      .catch((caught) => {
        if (!cancelled) setError(normalizeError(caught, "Could not start a session for connectors"));
      })
      .finally(() => {
        if (!cancelled) setSessionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, cwd, sessionId]);

  // Read uncached: a cached catalog can arrive before the handshake and `tools/list` finish, which
  // is exactly the empty-tools row the user came here to toggle. staleTime 0 so opening the tab
  // always refetches — the agent call is slow and a fresh 15s cache would skip the loading cue.
  const servers = useQuery({
    queryKey: ["connectors", sessionId],
    queryFn: () => listConnectors(sessionId ?? undefined, false),
    enabled: connected && Boolean(sessionId),
    staleTime: 0,
    retry: 0,
  });

  useEffect(() => {
    if (!servers.data?.servers) return;
    const store = useCatalogStore.getState();
    setMcpServers(mergeMcpCatalog(store.mcpServers, servers.data.servers));
  }, [servers.data, setMcpServers]);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["connectors"] });

  const toggle = useMutation({
    mutationFn: ({ serverName, enabled }: { serverName: string; enabled: boolean }) => {
      if (!sessionId) throw new Error("Start a conversation before changing connectors");
      return toggleConnector(sessionId, serverName, enabled);
    },
    onSuccess: () => { setError(null); refresh(); },
    onError: (caught) => setError(normalizeError(caught, "Could not update the connector")),
  });

  const toggleTool = useMutation({
    mutationFn: ({ serverName, toolName, enabled }: { serverName: string; toolName: string; enabled: boolean }) => {
      if (!sessionId) throw new Error("Start a conversation before changing tools");
      return toggleConnectorTool(sessionId, serverName, toolName, enabled);
    },
    onSuccess: () => { setError(null); refresh(); },
    onError: (caught) => setError(normalizeError(caught, "Could not update the connector")),
  });

  const remove = useMutation({
    mutationFn: (serverName: string) => {
      if (!sessionId) throw new Error("Start a conversation before deleting connectors");
      return deleteConnector(sessionId, serverName);
    },
    onSuccess: () => {
      setError(null);
      setPendingDelete(null);
      refresh();
    },
    onError: (caught) => setError(normalizeError(caught, "Could not update the connector")),
  });

  const authStatus = useMutation({
    mutationFn: (serverName: string) => {
      if (!sessionId) throw new Error("Start a conversation before checking connector auth");
      return mcpAuthStatus(sessionId, serverName);
    },
    onSuccess: (result, serverName) => {
      setError(null);
      const entry = result.servers?.find((server) => server.serverName === serverName);
      setAuthNote(entry ? `${serverName}: ${entry.status}` : `${serverName}: checked`);
      refresh();
    },
    onError: (caught) => setError(normalizeError(caught, "Could not update the connector")),
  });

  const authTrigger = useMutation({
    mutationFn: (serverName: string) => {
      if (!sessionId) throw new Error("Start a conversation before authenticating connectors");
      return mcpAuthTrigger(sessionId, serverName);
    },
    onSuccess: (result, serverName) => {
      setError(null);
      if (result.status === "setup_required") {
        setAuthNote(`${serverName}: setup required`);
        beginSetup(mcpServers.find((server) => server.name === serverName) ?? { name: serverName });
      } else if (result.error) {
        setError(normalizeError(result.error, "Connector authentication failed"));
      } else {
        setAuthNote(`${serverName}: ${result.status}`);
      }
      refresh();
    },
    onError: (caught) => setError(normalizeError(caught, "Could not authenticate the connector")),
  });

  const setup = useMutation({
    mutationFn: ({ serverName, values }: { serverName: string; values: Record<string, string> }) => {
      if (!sessionId) throw new Error("Start a conversation before completing connector setup");
      return mcpSetup(sessionId, serverName, values);
    },
    onSuccess: () => {
      setError(null);
      setSetupFor(null);
      setSetupValues({});
      setAuthNote(null);
      refresh();
    },
    onError: (caught) => setError(normalizeError(caught, "Could not set up the connector")),
  });

  const add = useMutation({
    mutationFn: () => {
      if (!sessionId) throw new Error("Start a conversation before adding connectors");
      if (!name.trim()) throw new Error("Give the connector a name");
      if (adding === "http") {
        return upsertConnector(sessionId, name.trim(), { type: "http", url: endpoint.trim() });
      }
      return upsertConnector(sessionId, name.trim(), {
        type: "stdio",
        command: endpoint.trim(),
        args: args.split(/\s+/).filter(Boolean),
      });
    },
    onSuccess: () => {
      setError(null);
      setAdding(null);
      onDirtyChange?.(false);
      setName("");
      setEndpoint("");
      setArgs("");
      refresh();
    },
    onError: (caught) => setError(normalizeError(caught, "Could not remove the connector")),
  });

  function beginSetup(server: McpServerView) {
    const fields = server.setup?.fields ?? [];
    const initial: Record<string, string> = { ...(server.setupValues ?? {}) };
    for (const field of fields) {
      if (initial[field.id] === undefined && field.default !== undefined) initial[field.id] = field.default;
      if (initial[field.id] === undefined && field.options?.[0]) initial[field.id] = field.options[0].value;
    }
    setSetupValues(initial);
    setSetupFor(server.name);
  }

  const list = mcpServers;
  // Session bootstrap + the uncached mcp/list both leave the panel empty for a long time.
  const awaitingSession = connected && Boolean(cwd) && !sessionId;
  const showLoading = sessionLoading || awaitingSession || (connected && Boolean(sessionId) && servers.isFetching);
  const connectorSections = groupConnectors(list);

  function renderGroup(group: ConnectorServerGroup) {
    const { server, tools, label, key } = group;
    const needsAuth = server.session?.authRequired === true;
    const needsSetup = server.session?.setupRequired === true;
    const settingUp = setupFor === server.name;
    const collapsed = collapsedGroups.has(key);
    const eligible = connectorEligibleCount(server);
    const enabledCount = connectorEnabledCount(server);
    const managed = isManagedGatewayServer(server);
    const toggling = toggle.isPending && toggle.variables?.serverName === server.name;

    return (
      <li key={server.name} data-testid={`connector-${server.name}`}>
        <SettingsGroupHeader
          label={label}
          count={tools.length}
          eligible={eligible}
          enabledCount={enabledCount}
          expanded={!collapsed}
          busy={toggling}
          testId={key}
          onToggleExpanded={() => setCollapsedGroups((current) => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          })}
          onToggleEnabled={(enabled) => {
            if (eligible > 0) toggle.mutate({ serverName: server.name, enabled });
          }}
        />
        {!collapsed && (
          <>
            <div className="connector-row connector-group-meta">
              <div className="connector-main">
                <small><Cable size={14} /> {serverTransportLabel(server)}</small>
                {server.session?.status && <small>{server.session.status}</small>}
                {server.session?.blockedReason && <small className="security-warning">{server.session.blockedReason}</small>}
              </div>
              <div className="connector-actions">
                {(needsAuth || needsSetup) && (
                  <div className="connector-auth-actions">
                    {needsAuth && (
                      <>
                        <button
                          type="button"
                          className="ghost-button"
                          data-testid={`connector-auth-status-${server.name}`}
                          disabled={authStatus.isPending}
                          onClick={() => authStatus.mutate(server.name)}
                        >
                          <KeyRound size={13} /> Auth status
                        </button>
                        <button
                          type="button"
                          className="ghost-button"
                          data-testid={`connector-auth-trigger-${server.name}`}
                          disabled={authTrigger.isPending}
                          onClick={() => authTrigger.mutate(server.name)}
                        >
                          Authenticate
                        </button>
                      </>
                    )}
                    {needsSetup && (
                      <button
                        type="button"
                        className="ghost-button"
                        data-testid={`connector-setup-${server.name}`}
                        onClick={() => beginSetup(server)}
                      >
                        <Settings2 size={13} /> Setup
                      </button>
                    )}
                  </div>
                )}
                {!managed && (
                  <button
                    type="button"
                    className="ghost-button"
                    data-testid={`connector-delete-${server.name}`}
                    aria-label={`Delete ${label}`}
                    onClick={() => setPendingDelete(server.name)}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </div>

            <ul className="connector-tools" data-testid={`connector-tools-${server.name}`}>
              {tools.map((tool) => (
                <li key={tool.name} data-testid={`connector-tool-${server.name}-${tool.name}`}>
                  <span title={tool.description}>{tool.displayName ?? tool.name}</span>
                  <ToggleSwitch
                    checked={tool.enabled !== false}
                    ariaLabel={`Toggle tool ${tool.name}`}
                    onChange={(enabled) => toggleTool.mutate({ serverName: server.name, toolName: tool.name, enabled })}
                    disabled={toggleTool.isPending || toggle.isPending || !serverEnabled(server)}
                  />
                </li>
              ))}
              {tools.length === 0 && (
                <li className="connector-tools-empty">
                  <span>
                    {server.session?.status === "initializing"
                      ? "Initializing tools…"
                      : serverEnabled(server)
                        ? "No tools reported yet"
                        : "Enable this connector to load its tools"}
                  </span>
                </li>
              )}
            </ul>

            {settingUp && (
              <form
                className="connector-form connector-setup-form"
                data-testid={`connector-setup-form-${server.name}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  setup.mutate({ serverName: server.name, values: setupValues });
                }}
              >
                {(server.setup?.fields ?? []).length === 0 ? (
                  <p className="settings-note">Submit to finish setup for this connector.</p>
                ) : (
                  (server.setup?.fields ?? []).map((field) => (
                    <label key={field.id} className="field">
                      <span>{field.label}{field.required ? " *" : ""}</span>
                      {field.options && field.options.length > 0 ? (
                        <select
                          aria-label={field.label}
                          value={setupValues[field.id] ?? ""}
                          onChange={(event) => setSetupValues((current) => ({ ...current, [field.id]: event.target.value }))}
                        >
                          {field.options.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          aria-label={field.label}
                          value={setupValues[field.id] ?? ""}
                          onChange={(event) => setSetupValues((current) => ({ ...current, [field.id]: event.target.value }))}
                        />
                      )}
                    </label>
                  ))
                )}
                <div className="settings-actions">
                  <button type="submit" className="primary-button" data-testid={`connector-setup-save-${server.name}`} disabled={setup.isPending}>
                    Save setup
                  </button>
                  <button type="button" className="ghost-button" onClick={() => { setSetupFor(null); setSetupValues({}); }}>Cancel</button>
                </div>
              </form>
            )}
          </>
        )}
      </li>
    );
  }

  return (
    <div className="connectors-panel">
      <div className="settings-actions">
        <button className="primary-button" data-testid="connector-add" disabled={!sessionId} onClick={() => { setAdding(adding ?? "stdio"); onDirtyChange?.(true); }}>
          <Plus size={15} /> Add
        </button>
        <button className="ghost-button" onClick={() => void servers.refetch()}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      {showLoading && list.length === 0 ? (
        <LoadingState label="Loading connectors" />
      ) : !sessionId ? (
        <EmptyState label="No active session" detail="Start a conversation to manage its connectors." />
      ) : servers.isError && list.length === 0 ? (
        <ErrorState label="Could not load connectors." />
      ) : list.length === 0 ? (
        <EmptyState label="No connectors" detail="Add an MCP server for this session." />
      ) : null}
      {showLoading && list.length > 0 && <LoadingState label="Refreshing connectors" />}
      {list.length > 0 && connectorSections.map((section) => (
        <section className="connector-section" key={section.caption}>
          <span className="connector-origin-caption">{section.caption}</span>
          <ul className="connector-list">{section.groups.map(renderGroup)}</ul>
        </section>
      ))}

      {adding && (
        <form
          className="connector-form"
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate();
          }}
        >
          <div className="segmented">
            <button type="button" className={adding === "stdio" ? "active" : ""} onClick={() => setAdding("stdio")}>stdio</button>
            <button type="button" className={adding === "http" ? "active" : ""} onClick={() => setAdding("http")}>HTTP</button>
          </div>
          <label className="field">
            <span>Name</span>
            <input value={name} aria-label="Connector name" onChange={(event) => setName(event.target.value)} placeholder="github" />
          </label>
          <label className="field">
            <span>{adding === "http" ? "URL" : "Command"}</span>
            <input
              value={endpoint}
              aria-label={adding === "http" ? "Connector URL" : "Connector command"}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder={adding === "http" ? "https://mcp.example.com/sse" : "npx"}
            />
          </label>
          {adding === "stdio" && (
            <label className="field">
              <span>Arguments</span>
              <input value={args} aria-label="Connector arguments" onChange={(event) => setArgs(event.target.value)} placeholder="-y @modelcontextprotocol/server-github" />
            </label>
          )}
          <div className="settings-actions">
            <button type="submit" className="primary-button" data-testid="connector-save" disabled={add.isPending}>Save connector</button>
            <button type="button" className="ghost-button" onClick={() => { setAdding(null); onDirtyChange?.(false); }}>Cancel</button>
          </div>
        </form>
      )}
      {authNote && <p className="settings-note" data-testid="connector-auth-note">{authNote}</p>}
      {error && <p className="settings-note security-warning" data-testid="connector-error">{error}</p>}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete ${pendingDelete}?`}
          description={`Removes ${pendingDelete} from the agent config for this session.`}
          confirmLabel="Delete connector"
          confirmTestId="connector-delete-confirm"
          danger
          busy={remove.isPending}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => remove.mutate(pendingDelete)}
        />
      )}
    </div>
  );
}
