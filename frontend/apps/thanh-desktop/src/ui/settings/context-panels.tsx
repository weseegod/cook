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

/** Project instructions for the open folder, read and written through the agent's fs extension. */
export function ProjectInstructionsPanel({ connected }: { connected: boolean }) {
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
      <p className="settings-note">{PROJECT_FILES.find((entry) => entry.path === activePath)?.description}</p>
      <p className="settings-note"><code>{absolute}</code></p>
      <textarea
        className="settings-textarea"
        rows={10}
        value={draft}
        aria-label="Project instructions"
        data-testid="project-instructions"
        placeholder={file.isError ? "This file does not exist yet — type instructions and save to create it." : ""}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="settings-actions">
        <button className="primary-button" disabled={save.isPending || !cwd} onClick={() => save.mutate()} data-testid="project-save">
          <Save size={15} /> Save instructions
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
      <p className="settings-note">
        Memory lives in the agent's own store under <code>~/.thanh</code>. Flush writes pending
        observations; rewrite re-summarises them; forgetting drops everything.
      </p>
      <div className="settings-actions">
        <button className="ghost-button" disabled={!connected || run.isPending} onClick={() => run.mutate("flush")} data-testid="memory-flush">
          <Brain size={15} /> Flush memory
        </button>
        <button className="ghost-button" disabled={!connected || run.isPending} onClick={() => run.mutate("rewrite")}>
          <Sparkles size={15} /> Rewrite memory
        </button>
        <button className="ghost-button" disabled={!connected || run.isPending} onClick={() => run.mutate("forget")}>
          Forget everything
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
      {skills.isLoading && <p className="settings-note">Loading skills…</p>}
      {skillList.length === 0 && !skills.isLoading && <p className="settings-note">No skills discovered.</p>}
      <ul className="skill-list">
        {skillList.map((skill) => (
          <li key={skill.name} data-testid={`skill-${skill.name}`}>
            <div>
              <strong>{skill.name}</strong>
              <small>{skill.description ?? "no description"}</small>
            </div>
            <label className="toggle-row">
              <span>{skill.enabled === false ? "Disabled" : "Enabled"}</span>
              <input
                type="checkbox"
                checked={skill.enabled !== false}
                aria-label={`Toggle skill ${skill.name}`}
                onChange={(event) => toggle.mutate({ name: skill.name, enabled: event.target.checked })}
              />
            </label>
          </li>
        ))}
      </ul>
      <h3>Plugins</h3>
      {pluginList.length === 0 && !plugins.isLoading && <p className="settings-note">No plugins installed.</p>}
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
      <p className="settings-note">Installing from the marketplace stays in the CLI for now.</p>
    </div>
  );
}
