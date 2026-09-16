import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { listConnectors, serverEnabled, serverTransportLabel, toggleConnector, upsertConnector } from "../../acp/extensions";
import { useSessionStore } from "../../state/session";

/** Settings → Connectors: the agent's MCP servers, their state, and add/toggle. */
export function ConnectorsPanel({ connected }: { connected: boolean }) {
  const sessionId = useSessionStore((state) => state.sessionId);
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState<"stdio" | "http" | null>(null);
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [args, setArgs] = useState("");
  const [error, setError] = useState<string | null>(null);

  const servers = useQuery({
    queryKey: ["connectors", sessionId],
    queryFn: () => listConnectors(sessionId ?? undefined, true),
    enabled: connected,
    retry: 0,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["connectors"] });

  const toggle = useMutation({
    mutationFn: ({ serverName, enabled }: { serverName: string; enabled: boolean }) => {
      if (!sessionId) throw new Error("Start a conversation before changing connectors");
      return toggleConnector(sessionId, serverName, enabled);
    },
    onSuccess: () => { setError(null); refresh(); },
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
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
      setName("");
      setEndpoint("");
      setArgs("");
      refresh();
    },
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
  });

  const list = servers.data?.servers ?? [];

  return (
    <div className="connectors-panel">
      <div className="settings-actions">
        <button className="primary-button" data-testid="connector-add" onClick={() => setAdding(adding ?? "stdio")}>
          <Plus size={15} /> Add connector
        </button>
        <button className="ghost-button" onClick={() => void servers.refetch()}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      {!sessionId && <p className="settings-note">Start a conversation to manage connectors; the agent exposes them per session.</p>}
      {servers.isLoading && <p className="settings-note">Loading connectors…</p>}
      {list.length === 0 && !servers.isLoading && <p className="settings-note">No MCP servers are configured.</p>}
      <ul className="connector-list">
        {list.map((server) => (
          <li key={server.name} data-testid={`connector-${server.name}`}>
            <div className="connector-main">
              <strong><Cable size={14} /> {server.name}</strong>
              <small>{serverTransportLabel(server)}</small>
              <small>{server.session?.tools?.length ?? 0} tools{server.session?.status ? ` · ${server.session.status}` : ""}</small>
            </div>
            <label className="toggle-row connector-toggle">
              <span>{serverEnabled(server) ? "Enabled" : "Disabled"}</span>
              <input
                type="checkbox"
                checked={serverEnabled(server)}
                aria-label={`Toggle ${server.name}`}
                onChange={(event) => toggle.mutate({ serverName: server.name, enabled: event.target.checked })}
              />
            </label>
          </li>
        ))}
      </ul>

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
            <button type="button" className="ghost-button" onClick={() => setAdding(null)}>Cancel</button>
          </div>
        </form>
      )}
      {error && <p className="settings-note security-warning" data-testid="connector-error">{error}</p>}
    </div>
  );
}
