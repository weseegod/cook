import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Plus, Puzzle, RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  PROJECT_FILES,
  listPlugins,
  listSkills,
  readProjectFile,
  toggleSkill,
  writeProjectFile,
} from "../../acp/extensions";
import {
  addSkill,
  listWorkflows,
  pluginsAction,
  reloadPlugins,
  removeSkill,
  resetSkills,
  skillsConfig,
} from "../../acp/settings-ext";
import { useCatalogStore } from "../../state/catalog";
import { useSessionStore } from "../../state/session";
import { EmptyState, LoadingState } from "../components/async-state";
import { InfoTip } from "../components/info-tip";
import { ToggleSwitch } from "../components/toggle-switch";

export { MemoryBrowserPanel as MemoryPanel } from "./memory-browser";

/** Project instructions for the open folder, read and written through the agent's fs extension. */
export function ProjectInstructionsPanel({ connected, onDirtyChange }: { connected: boolean; onDirtyChange?: (dirty: boolean) => void }) {
  const { cwd, sessionId } = useSessionStore();
  const [activePath, setActivePath] = useState(PROJECT_FILES[0].path);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const absolute = cwd ? `${cwd.replace(/\/$/, "")}/${activePath}` : activePath;

  const file = useQuery({
    queryKey: ["project-file", absolute, sessionId],
    queryFn: () => readProjectFile(sessionId ?? undefined, absolute),
    enabled: connected && Boolean(cwd),
    retry: 0,
  });

  // Seed the editor once per file: a later refetch (ours, or a window-focus refetch) must not
  // overwrite what the user is typing or wipe the "Saved" confirmation.
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!file.isSuccess || seeded.current === absolute) return;
    seeded.current = absolute;
    setDraft(file.data?.content ?? "");
  }, [file.isSuccess, file.data, absolute]);

  useEffect(() => {
    seeded.current = null;
    setStatus(null);
  }, [activePath]);

  const save = useMutation({
    mutationFn: async () => {
      if (!absolute || !cwd) throw new Error("Open a folder first");
      await writeProjectFile(sessionId ?? undefined, absolute, draft);
      return absolute;
    },
    onSuccess: (path) => {
      setStatus(`Saved ${path}`);
      onDirtyChange?.(false);
      void queryClient.invalidateQueries({ queryKey: ["project-file"] });
    },
    onError: (error) => setStatus(error instanceof Error ? error.message : String(error)),
  });

  return (
    <div className="project-panel">
      <div className="segmented">
        {PROJECT_FILES.map((entry) => (
          <button key={entry.path} className={entry.path === activePath ? "active" : ""} onClick={() => setActivePath(entry.path)}>
            {entry.label}
          </button>
        ))}
      </div>
      <p className="settings-path"><code>{absolute}</code> <InfoTip label="Project file">{PROJECT_FILES.find((entry) => entry.path === activePath)?.description}</InfoTip></p>
      <textarea
        className="settings-textarea"
        rows={10}
        value={draft}
        aria-label="Project instructions"
        data-testid="project-instructions"
        aria-busy={file.isLoading}
        placeholder={file.isError ? "Start typing…" : ""}
          onChange={(event) => { setDraft(event.target.value); onDirtyChange?.(true); }}
      />
      {file.isLoading && <LoadingState label="Loading file" />}
      {file.isError && <EmptyState label="File not found yet" detail="Start typing to create it in this workspace." />}
      <div className="settings-actions">
        <button className="primary-button" disabled={save.isPending || !cwd} onClick={() => save.mutate()} data-testid="project-save">
          <Save size={15} /> Save
        </button>
      </div>
      {status && <p className="settings-note" data-testid="project-status"><FileText size={13} /> {status}</p>}
    </div>
  );
}

/** Settings → Skills: toggle, add/remove/reset (+ config), plugins enable/reload, workflows list. */
export function SkillsPanel({ connected }: { connected: boolean }) {
  const cwd = useSessionStore((state) => state.cwd);
  const sessionId = useSessionStore((state) => state.sessionId);
  const catalogPlugins = useCatalogStore((state) => state.plugins);
  const queryClient = useQueryClient();
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(() => new Set());
  const [skillPath, setSkillPath] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [configMessage, setConfigMessage] = useState<string | null>(null);

  const skills = useQuery({ queryKey: ["skills", cwd], queryFn: () => listSkills(cwd ?? undefined), enabled: connected, retry: 0 });
  const plugins = useQuery({
    queryKey: ["plugins", sessionId],
    queryFn: () => listPlugins(sessionId ?? undefined),
    enabled: connected,
    retry: 0,
  });
  const workflows = useQuery({
    queryKey: ["workflows", sessionId],
    queryFn: () => listWorkflows(sessionId!),
    enabled: connected && Boolean(sessionId),
    retry: 0,
  });

  const skillList = skills.data?.skills ?? skills.data?.items ?? [];
  const pluginList = plugins.data?.plugins ?? plugins.data?.items ?? (catalogPlugins.length > 0 ? catalogPlugins : []);
  const workflowList = workflows.data?.workflows ?? [];

  const toggle = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => toggleSkill(name, enabled, cwd ?? undefined),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["skills"] }),
  });

  const mutateSkills = useMutation({
    mutationFn: async (op: "add" | "remove" | "reset" | "config") => {
      if (op === "add") {
        if (!skillPath.trim()) throw new Error("Enter a skill path");
        return addSkill(skillPath.trim(), cwd ?? undefined);
      }
      if (op === "remove") {
        if (!skillPath.trim()) throw new Error("Enter a skill path to remove");
        return removeSkill(skillPath.trim(), cwd ?? undefined);
      }
      if (op === "reset") return resetSkills(cwd ?? undefined);
      return skillsConfig(cwd ?? undefined);
    },
    onSuccess: (result, op) => {
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
      if (op === "config") {
        setConfigMessage(typeof result === "object" && result && "message" in result ? String(result.message ?? "") : null);
        setStatus("Config loaded");
      } else {
        setStatus(typeof result === "object" && result && "message" in result ? String(result.message ?? `${op} ok`) : `${op} ok`);
        if (op === "add" || op === "remove") setSkillPath("");
      }
    },
    onError: (error) => setStatus(error instanceof Error ? error.message : String(error)),
  });

  const pluginMut = useMutation({
    mutationFn: async (op: { kind: "reload" } | { kind: "toggle"; id: string; enabled: boolean }) => {
      if (op.kind === "reload") return reloadPlugins();
      if (!sessionId) throw new Error("No session");
      return pluginsAction(sessionId, op.enabled
        ? { type: "enable", plugin_id: op.id }
        : { type: "disable", plugin_id: op.id });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
      setStatus("Plugins updated");
    },
    onError: (error) => setStatus(error instanceof Error ? error.message : String(error)),
  });

  return (
    <div className="skills-panel">
      <h3>Skills</h3>
      {skills.isLoading && <LoadingState label="Loading skills" />}
      {skillList.length === 0 && !skills.isLoading && <EmptyState label="No skills" detail="Skills discovered in this workspace will appear here." />}
      <ul className="skill-list">
        {skillList.map((skill) => (
          <li key={skill.name} data-testid={`skill-${skill.name}`}>
            <div>
              <strong>{skill.name}</strong>
              {skill.description && (
                <button
                  type="button"
                  className={`skill-description${expandedSkills.has(skill.name) ? " expanded" : ""}`}
                  aria-expanded={expandedSkills.has(skill.name)}
                  onClick={() => setExpandedSkills((current) => {
                    const next = new Set(current);
                    if (next.has(skill.name)) next.delete(skill.name);
                    else next.add(skill.name);
                    return next;
                  })}
                >
                  {skill.description}
                </button>
              )}
            </div>
            <div className="skill-toggle">
              <ToggleSwitch
                checked={skill.enabled !== false}
                ariaLabel={`Toggle skill ${skill.name}`}
                onChange={(enabled) => toggle.mutate({ name: skill.name, enabled })}
                disabled={toggle.isPending}
              />
            </div>
          </li>
        ))}
      </ul>

      <div className="skills-mutate" data-testid="skills-mutate">
        <label className="field">
          <span>Skill path</span>
          <input
            value={skillPath}
            onChange={(event) => setSkillPath(event.target.value)}
            placeholder="~/skills/my-skill or path/to/SKILL.md"
            data-testid="skill-path-input"
          />
        </label>
        <div className="settings-actions">
          <button className="ghost-button" disabled={!connected || mutateSkills.isPending} onClick={() => mutateSkills.mutate("add")} data-testid="skill-add">
            <Plus size={15} /> Add
          </button>
          <button className="ghost-button" disabled={!connected || mutateSkills.isPending} onClick={() => mutateSkills.mutate("remove")} data-testid="skill-remove">
            <Trash2 size={15} /> Remove
          </button>
          <button className="ghost-button" disabled={!connected || mutateSkills.isPending} onClick={() => mutateSkills.mutate("reset")} data-testid="skill-reset">
            Reset
          </button>
          <button className="ghost-button" disabled={!connected || mutateSkills.isPending} onClick={() => mutateSkills.mutate("config")} data-testid="skill-config">
            Config
          </button>
        </div>
        {configMessage && <pre className="settings-note skills-config-message" data-testid="skills-config-message">{configMessage}</pre>}
      </div>

      <h3>Plugins</h3>
      <div className="settings-actions">
        <button
          className="ghost-button"
          disabled={!connected || pluginMut.isPending}
          onClick={() => pluginMut.mutate({ kind: "reload" })}
          data-testid="plugins-reload"
        >
          <RefreshCw size={15} /> Reload plugins
        </button>
      </div>
      {plugins.isLoading && <LoadingState label="Loading plugins" />}
      {pluginList.length === 0 && !plugins.isLoading && <EmptyState label="No plugins" />}
      <ul className="skill-list">
        {pluginList.map((plugin) => {
          const id = plugin.id ?? plugin.name;
          return (
            <li key={id} data-testid={`plugin-${plugin.name}`}>
              <div>
                <strong><Puzzle size={14} /> {plugin.name}</strong>
                <small>{plugin.version ?? "version unknown"}{plugin.scope ? ` · ${plugin.scope}` : ""}</small>
              </div>
              <div className="skill-toggle">
                <ToggleSwitch
                  checked={plugin.enabled !== false}
                  ariaLabel={`Toggle plugin ${plugin.name}`}
                  disabled={pluginMut.isPending || !sessionId || !plugin.id}
                  onChange={(enabled) => {
                    if (!plugin.id) return;
                    pluginMut.mutate({ kind: "toggle", id: plugin.id, enabled });
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>

      <section className="workflows-section" data-testid="workflow-list">
        <h3>Workflows</h3>
        {workflows.isLoading && <LoadingState label="Loading workflows" />}
        {workflowList.length === 0 && !workflows.isLoading && (
          <EmptyState label="No workflows" detail="/workflow stays a prompt; this list is browse-only." />
        )}
        <ul className="skill-list">
          {workflowList.map((workflow) => (
            <li key={workflow.name} data-testid={`workflow-${workflow.name}`}>
              <div>
                <strong>{workflow.name}</strong>
                {(workflow.description || workflow.whenToUse || workflow.when_to_use) && (
                  <small>{workflow.description ?? workflow.whenToUse ?? workflow.when_to_use}</small>
                )}
              </div>
              {workflow.source && <small>{workflow.source}</small>}
            </li>
          ))}
        </ul>
      </section>

      {status && <p className="settings-note" data-testid="skills-status">{status}</p>}
    </div>
  );
}
