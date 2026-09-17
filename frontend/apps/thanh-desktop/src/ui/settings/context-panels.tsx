import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, FileText, Puzzle, Save, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  PROJECT_FILES,
  flushMemory,
  forgetMemory,
  listPlugins,
  listSkills,
  readProjectFile,
  rewriteMemory,
  toggleSkill,
  writeProjectFile,
} from "../../acp/extensions";
import { useSessionStore } from "../../state/session";
import { EmptyState, LoadingState } from "../components/async-state";
import { InfoTip } from "../components/info-tip";
import { ToggleSwitch } from "../components/toggle-switch";

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

/** Settings → Memory: flush/rewrite the agent's memory store. */
export function MemoryPanel({ connected }: { connected: boolean }) {
  const [status, setStatus] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: async (action: "flush" | "rewrite" | "forget") => {
      if (action === "flush") return flushMemory();
      if (action === "rewrite") return rewriteMemory();
      return forgetMemory();
    },
    onSuccess: (_result, action) => setStatus(`${action} requested`),
    onError: (error) => setStatus(error instanceof Error ? error.message : String(error)),
  });

  return (
    <div className="memory-panel">
      <div className="settings-actions">
        <button className="ghost-button" disabled={!connected || run.isPending} onClick={() => run.mutate("flush")} data-testid="memory-flush">
          <Brain size={15} /> Flush
        </button>
        <button className="ghost-button" disabled={!connected || run.isPending} onClick={() => run.mutate("rewrite")}>
          <Sparkles size={15} /> Rewrite
        </button>
        <button className="ghost-button" disabled={!connected || run.isPending} onClick={() => run.mutate("forget")}>
          Forget
        </button>
      </div>
      {status && <p className="settings-note" data-testid="memory-status">{status}</p>}
    </div>
  );
}

/** Settings → Skills: browse and enable/disable the agent's skills and plugins. */
export function SkillsPanel({ connected }: { connected: boolean }) {
  const cwd = useSessionStore((state) => state.cwd);
  const queryClient = useQueryClient();
  const skills = useQuery({ queryKey: ["skills", cwd], queryFn: () => listSkills(cwd ?? undefined), enabled: connected, retry: 0 });
  const plugins = useQuery({ queryKey: ["plugins"], queryFn: listPlugins, enabled: connected, retry: 0 });
  const skillList = skills.data?.skills ?? skills.data?.items ?? [];
  const pluginList = plugins.data?.plugins ?? plugins.data?.items ?? [];
  const toggle = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => toggleSkill(name, enabled, cwd ?? undefined),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["skills"] }),
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
              {skill.description && <InfoTip label={skill.name}>{skill.description}</InfoTip>}
            </div>
            <div className="toggle-row">
              <span>{skill.enabled === false ? "Off" : "On"}</span>
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
      <h3>Plugins</h3>
      {plugins.isLoading && <LoadingState label="Loading plugins" />}
      {pluginList.length === 0 && !plugins.isLoading && <EmptyState label="No plugins" />}
      <ul className="skill-list">
        {pluginList.map((plugin) => (
          <li key={plugin.name} data-testid={`plugin-${plugin.name}`}>
            <div>
              <strong><Puzzle size={14} /> {plugin.name}</strong>
              <small>{plugin.version ?? "version unknown"}</small>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
