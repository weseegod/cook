import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Plus, Puzzle, RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  PROJECT_FILES,
  listPlugins,
  listSkills,
  normalizeSkill,
  readProjectFile,
  toggleSkills,
  writeProjectFile,
  type SkillView,
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
import { normalizeError } from "../../acp/errors";
import { useCatalogStore } from "../../state/catalog";
import { useSessionStore } from "../../state/session";
import { EmptyState, ErrorState, LoadingState } from "../components/async-state";
import { InfoTip } from "../components/info-tip";
import { ToggleSwitch } from "../components/toggle-switch";
import { SettingsGroupHeader } from "./group-header";
import { groupEnabledCount, groupSkills, groupToggleTargets } from "./skills-groups";

export { MemoryBrowserPanel as MemoryPanel } from "./memory-browser";

/** Project instructions for the open folder, read and written through the agent's fs extension. */
export function ProjectInstructionsPanel({ connected, onDirtyChange }: { connected: boolean; onDirtyChange?: (dirty: boolean) => void }) {
  const cwd = useSessionStore((state) => state.cwd);
  const sessionId = useSessionStore((state) => state.sessionId);
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
    onError: (error) => setStatus(normalizeError(error, "Could not update project instructions")),
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
  const [query, setQuery] = useState("");
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(() => new Set());
  /** Groups the user folded shut. Groups start expanded; a search opens every group with a match. */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [skillPath, setSkillPath] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [configMessage, setConfigMessage] = useState<string | null>(null);

  const skills = useQuery({
    queryKey: ["skills", cwd],
    queryFn: () => listSkills(cwd ?? undefined),
    enabled: connected,
    staleTime: 0,
    retry: 0,
  });
  const plugins = useQuery({
    queryKey: ["plugins", sessionId],
    queryFn: () => listPlugins(sessionId ?? undefined),
    // `x.ai/plugins/list` requires a session id. Without one the U-plug notification still fills
    // the catalog, so there is nothing useful to ask for.
    enabled: connected && Boolean(sessionId),
    staleTime: 0,
    retry: 0,
  });
  const workflows = useQuery({
    queryKey: ["workflows", sessionId],
    queryFn: () => listWorkflows(sessionId!),
    enabled: connected && Boolean(sessionId),
    staleTime: 0,
    retry: 0,
  });

  const skillList = skills.data?.skills ?? [];
  const pluginList = plugins.data?.plugins ?? plugins.data?.items ?? (catalogPlugins.length > 0 ? catalogPlugins : []);
  const workflowList = workflows.data?.workflows ?? [];
  const groups = groupSkills(skillList, query);
  const skillsBusy = connected && skills.isFetching;
  const blockSkills = skillsBusy && skillList.length === 0;
  const pluginsBusy = connected && Boolean(sessionId) && plugins.isFetching;
  const workflowsBusy = connected && Boolean(sessionId) && workflows.isFetching;

  const toggle = useMutation({
    // Row and group both fan out `{ name, enabled, cwd }` — the installed CLI has no `names[]`.
    mutationFn: ({ names, enabled }: { names: string[]; enabled: boolean }) =>
      toggleSkills(names, enabled, cwd ?? undefined),
    // The switch moves immediately; the agent's full list replaces it on success.
    onMutate: async ({ names, enabled }) => {
      await queryClient.cancelQueries({ queryKey: ["skills", cwd] });
      const previous = queryClient.getQueryData<{ skills: SkillView[] }>(["skills", cwd]);
      if (previous) {
        const target = new Set(names);
        queryClient.setQueryData(["skills", cwd], {
          skills: previous.skills.map((skill) => (target.has(skill.name) ? { ...skill, enabled } : skill)),
        });
      }
      return { previous };
    },
    onSuccess: (result) => {
      setStatus(null);
      if (result?.skills?.length) {
        queryClient.setQueryData(["skills", cwd], { skills: result.skills.map(normalizeSkill) });
      }
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(["skills", cwd], context.previous);
      setStatus(normalizeError(error, "Could not update skills"));
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
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
        setConfigMessage(typeof result === "object" && result && "message" in result ? normalizeError(result.message, "") : null);
        setStatus("Config loaded");
      } else {
        setStatus(typeof result === "object" && result && "message" in result ? normalizeError(result.message, `${op} ok`) : `${op} ok`);
        if (op === "add" || op === "remove") setSkillPath("");
      }
    },
    onError: (error) => setStatus(normalizeError(error, "Could not update skills")),
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
    onError: (error) => setStatus(normalizeError(error, "Could not update plugins")),
  });

  return (
    <div className="skills-panel">
      <h3>Skills</h3>
      {blockSkills && <LoadingState label="Loading skills" />}
      {skillsBusy && skillList.length > 0 && <LoadingState label="Refreshing skills" />}
      {skills.isError && (
        <ErrorState label={normalizeError(skills.error, "Could not load skills from the agent.")} />
      )}
      {!blockSkills && !skills.isError && (
        <>
          <label className="field skill-search">
            <span>Search</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by name, description or source"
              aria-label="Search skills"
              data-testid="skill-search"
            />
          </label>
          <p className="settings-note" data-testid="skills-summary">
            {skillList.length} skill{skillList.length === 1 ? "" : "s"} found
            {query && ` · ${groups.reduce((count, group) => count + group.skills.length, 0)} matching`}
          </p>
          {skillList.length === 0 && !skillsBusy && (
            <EmptyState
              label="No skills"
              detail={cwd
                ? "Skills discovered here and in ~/.cook will appear after the agent finds them."
                : "Open a folder, then reopen this tab to list project skills."}
            />
          )}
          {skillList.length > 0 && groups.length === 0 && (
            <EmptyState label="No matching skills" detail="Clear the search to see every discovered skill." />
          )}
          {status && <p className="settings-note security-warning" data-testid="skills-status">{status}</p>}
          {groups.map((group) => {
            const enabledCount = groupEnabledCount(group.skills);
            // A search is a question about every match, so it opens the groups holding one.
            const expanded = Boolean(query.trim()) || !collapsedGroups.has(group.label);
            return (
              <div className="skill-group" key={group.label}>
                <SettingsGroupHeader
                  label={group.label}
                  count={group.skills.length}
                  eligible={group.skills.length}
                  enabledCount={enabledCount}
                  expanded={expanded}
                  // Any in-flight fan-out must freeze every group switch — parallel
                  // read-modify-writes tear `[skills].disabled`.
                  busy={toggle.isPending}
                  testId={`skill-group-${group.label}`}
                  onToggleExpanded={() => setCollapsedGroups((current) => {
                    const next = new Set(current);
                    if (next.has(group.label)) next.delete(group.label);
                    else next.add(group.label);
                    return next;
                  })}
                  onToggleEnabled={(enabled) => {
                    if (toggle.isPending) return;
                    const names = groupToggleTargets(group.skills, enabled);
                    if (names.length > 0) toggle.mutate({ names, enabled });
                  }}
                />
                {expanded && (
                  <ul className="skill-list">
                    {group.skills.map((skill) => {
                      const label = skill.displayName ?? skill.name;
                      return (
                        <li key={skill.path ?? `${group.label}:${skill.name}`} data-testid={`skill-${skill.name}`}>
                          <div>
                            <strong title={skill.path}>{label}</strong>
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
                              onChange={(enabled) => {
                                if (toggle.isPending) return;
                                toggle.mutate({ names: [skill.name], enabled });
                              }}
                              disabled={toggle.isPending}
                            />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </>
      )}

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
      {pluginsBusy && pluginList.length === 0 && <LoadingState label="Loading plugins" />}
      {pluginsBusy && pluginList.length > 0 && <LoadingState label="Refreshing plugins" />}
      {pluginList.length === 0 && !pluginsBusy && <EmptyState label="No plugins" />}
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
        {workflowsBusy && workflowList.length === 0 && <LoadingState label="Loading workflows" />}
        {workflowsBusy && workflowList.length > 0 && <LoadingState label="Refreshing workflows" />}
        {workflowList.length === 0 && !workflowsBusy && (
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

      {status && skillList.length === 0 && (
        <p className="settings-note security-warning" data-testid="skills-status">{status}</p>
      )}
    </div>
  );
}
