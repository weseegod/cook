#!/usr/bin/env python3
"""Deterministic collector for the /learn skill.

Walks a Grok Build home (default: $GROK_HOME or ~/.cook), keeps the sessions the
user actually sat at, and writes a compact run directory that the learn-traces.rhai
workflow shards across agents:

  <run>/manifest.json        params, counts, kept session ids in file order (run dir defaults to <OS temp>/learn/<stamp>)
  <run>/sessions/NNNN-<id>.json  one compact record per kept session
  <run>/surfaces.json        skills, plugins, MCP servers, hooks, workflows (names only)
  <run>/usage.json           hit counts per surface item across kept sessions
  <run>/phrases.json         repeated prompts, prompt stems, repeated instruction lines
  <run>/decisions.jsonl      copy of prior /learn decisions, if any

Stdlib only. Never prints or copies config values other than names.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse

SUBAGENT_KINDS = {"subagent", "subagent_resume", "subagent_fork"}
# scratch locations on every OS; sessions started there are fixtures and tests, not the user's work
DEFAULT_EXCLUDE_CWD = sorted({
    os.path.normcase(os.path.normpath(p))
    for p in (tempfile.gettempdir(), os.path.realpath(tempfile.gettempdir()), "/tmp", "/private/tmp", "/var/folders")
})
DEFAULT_EXCLUDE_SUBSTR = ["grok-e2e"]


def retire_stale_workflow_copy(grok_home: str) -> dict | None:
    """Move a user-level learn-traces.rhai out of the way when it differs from this skill's copy.

    The workflow registry lets a user workflow shadow a bundled one of the same name, so the copy the Sep 10
    hotfix wrote to <GROK_HOME>/workflows keeps launching the launch-era prompt on upgraded clients. The
    SKILL.md asks the parent to check; runs still slipped through, so the collector does it. Reversible: the
    copy goes to <GROK_HOME>/learn/trash/<stamp>-stale-workflow/. Older clients that need the copy get a fresh
    one written by the launch step.
    """
    user_copy = os.path.join(grok_home, "workflows", "learn-traces.rhai")
    skill_copy = os.path.join(os.path.dirname(os.path.abspath(__file__)), "learn-traces.rhai")
    if not (os.path.isfile(user_copy) and os.path.isfile(skill_copy)):
        return None
    try:
        with open(user_copy, "rb") as f:
            theirs = f.read()
        with open(skill_copy, "rb") as f:
            ours = f.read()
    except OSError:
        return None
    if theirs == ours or b'name: "learn-traces"' not in theirs:
        return None
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S")
    dest_dir = os.path.join(grok_home, "learn", "trash", f"{stamp}-stale-workflow")
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, "learn-traces.rhai")
    shutil.move(user_copy, dest)
    log(f"retired a stale user copy of learn-traces.rhai (shadowed the bundled workflow) -> {dest}")
    return {"from": user_copy, "to": dest}


def prune_old_runs(runs_dir: str, keep_days: int) -> None:
    """Delete run directories older than keep_days (by name stamp) so GROK_HOME/learn/runs does not grow forever."""
    if not os.path.isdir(runs_dir):
        return
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=keep_days)
    for name in os.listdir(runs_dir):
        try:
            when = dt.datetime.strptime(name[:15], "%Y%m%d-%H%M%S").replace(tzinfo=dt.timezone.utc)
        except ValueError:
            continue
        if when < cutoff:
            shutil.rmtree(os.path.join(runs_dir, name), ignore_errors=True)
TURN_CAP = 2000
USER_QUERY_RE = re.compile(r"<user_query>(.*?)</user_query>", re.S)
# pasted credentials must not be copied into the run directory
# a credential is one unbroken run of letters and digits with digits in it; hyphenated words
# (npm-package-for-widgets, sk-learn-utils) and 40-hex git SHAs are not credentials
SECRET_RES = [
    # prefixed keys: sk-…, sk-proj-…, ghp_…, xai-…; hyphens allowed inside but at least three digits, so package names stay
    re.compile(r"\b(xai|sk|ghp|gho|ghu|ghs|glpat|npm)[-_](?=(?:[A-Za-z_\-]*\d){3})[A-Za-z0-9_\-]{16,}\b"),
    re.compile(r"\b(AKIA|ASIA)[A-Z0-9]{16}\b"),
    re.compile(r"\bxox[abpsr]-\d[A-Za-z0-9-]{20,}\b"),
    re.compile(r"\b[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\b"),  # JWT
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9_\-./+=]{20,}"),
    re.compile(r"(?i)\b(token|api[_-]?key|secret|password|passwd)\b\s*[:=]\s*['\"]?(?=[A-Za-z0-9_\-./+=]*\d)[A-Za-z0-9_\-./+=]{16,}"),
    re.compile(r"\b[a-f0-9]{64,}\b"),
]


def redact(text: str) -> str:
    for rx in SECRET_RES:
        text = rx.sub(lambda m: m.group(0)[:8] + "…[redacted]", text)
    return text
# a slash command, not a path segment (~/x, ./x, a/b) and not followed by more path
SLASH_RE = re.compile(r"(?<![\w/~.])/([a-z][a-z0-9-]{1,63})\b(?!/)")
# prompts the TUI writes on the user's behalf
DEFAULT_DROP_PATTERNS = [r"^the user invoked `/feedback`"]
SKILL_PATH_RE = re.compile(r"[/\\]skills[/\\]([^/\\]+)[/\\]SKILL\.md$")
WORD_RE = re.compile(r"\s+")
# slash tokens that are TUI commands or common path fragments, not skills
SLASH_STOP = {
    "tmp", "usr", "bin", "etc", "var", "dev", "opt", "home", "users", "private",
    "api", "v1", "v2", "src", "lib", "test", "tests", "docs", "help", "quit",
    "exit", "clear", "model", "compact", "rewind", "rename", "workflows",
    "workflow", "feedback", "btw", "loop", "resume", "status", "config",
    "init", "login", "logout", "mcp", "plugins", "skills", "memory", "diff",
    "review", "commit", "pr", "cost", "doctor", "theme", "vim", "terminal",
}


# Cost model, calibrated on real learn-traces runs (per-agent tokens_used from the workflow journal):
# mappers ~1.1M per 10 sessions, reducer 1.3-2.9M, verifiers 0.4-1.8M each, report 2.3-2.7M;
# wall time 23-66 min across 10 runs and mostly independent of session count (mappers run in parallel).
MAP_TOKENS_PER_SESSION = {10: 110_000, 1: 250_000}
REDUCER_TOKENS = 1_300_000
VERIFIER_TOKENS = 800_000
REPORT_TOKENS = 2_500_000
FIXED_AGENTS = 4  # 3 verifiers + 1 report
FAN = 10


def estimate(n: int, batch: int = 10) -> dict:
    """Agents, tokens, and wall time for a run over n sessions; the same arithmetic the workflow does."""
    if n <= 0:
        return {"sessions": 0, "agents": 0, "mappers": 0, "reducers": 0, "tokens": 0, "tokens_m": 0.0, "minutes": [0, 0]}
    mappers = -(-n // batch)
    reducers, level = 0, mappers
    while True:
        groups = -(-level // FAN)
        reducers += groups
        level = groups
        if groups <= 1:
            break
    per_session = MAP_TOKENS_PER_SESSION.get(batch, MAP_TOKENS_PER_SESSION[10] * 10 // batch)
    tokens = n * per_session + reducers * REDUCER_TOKENS + 3 * VERIFIER_TOKENS + REPORT_TOKENS
    mid = 30 + n // 6
    return {"sessions": n, "agents": mappers + reducers + FIXED_AGENTS, "mappers": mappers, "reducers": reducers,
            "tokens": tokens, "tokens_m": round(tokens / 1e6, 1), "minutes": [max(15, mid - 15), mid + 20]}


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def read_json(path: str):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def parse_time(s):
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def frontmatter(path: str) -> dict:
    """Return name/description from a SKILL.md frontmatter without a YAML dependency."""
    out = {"name": os.path.basename(os.path.dirname(path)), "description": ""}
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            head = f.read(4000)
    except OSError:
        return out
    if not head.startswith("---"):
        return out
    body = head.split("---", 2)
    if len(body) < 3:
        return out
    fm = body[1]
    m = re.search(r"^name:\s*(.+)$", fm, re.M)
    if m:
        out["name"] = m.group(1).strip().strip("'\"")
    m = re.search(r"^description:\s*(.*)$", fm, re.M)
    if m:
        desc = m.group(1).strip()
        if desc in (">", ">-", "|", "|-", ""):
            lines = []
            after = fm[m.end():].splitlines()
            for line in after:
                if line.startswith((" ", "\t")):
                    lines.append(line.strip())
                elif line.strip() == "":
                    continue
                else:
                    break
            desc = " ".join(lines)
        out["description"] = desc.strip("'\"")[:300]
    return out


def toml_string_array(text: str, table: str, key: str) -> list[str] | None:
    """Read `key = [ "a", "b" ]` under `[table]` without reading any other value."""
    m = re.search(r"^\[" + re.escape(table) + r"\]\s*$", text, re.M)
    if not m:
        return None
    rest = text[m.end():]
    nxt = re.search(r"^\[", rest, re.M)
    if nxt:
        rest = rest[: nxt.start()]
    km = re.search(r"^" + re.escape(key) + r"\s*=\s*\[", rest, re.M)
    if not km:
        return None
    depth, i, start = 0, km.end() - 1, km.end() - 1
    while i < len(rest):
        if rest[i] == "[":
            depth += 1
        elif rest[i] == "]":
            depth -= 1
            if depth == 0:
                break
        i += 1
    return re.findall(r'"([^"]+)"', rest[start : i + 1])


def toml_subtables(text: str, table: str) -> list[str]:
    names = []
    for m in re.finditer(r"^\[" + re.escape(table) + r"\.([^\].]+)\]", text, re.M):
        if m.group(1) not in names:
            names.append(m.group(1))
    return names


# ---------------------------------------------------------------- surfaces


def git_tracked(path: str, root: str) -> bool | None:
    try:
        r = subprocess.run(["git", "-C", root, "ls-files", "--error-unmatch", "--", path],
                           capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.returncode == 0


def under(path: str, base: str) -> bool:
    path, base = os.path.normcase(os.path.normpath(path)), os.path.normcase(os.path.normpath(base))
    return path == base or path.startswith(base.rstrip(os.sep) + os.sep)


def project_skill_dirs(cwd: str, git_root: str) -> list[tuple[str, str]]:
    """(.grok/skills dir, owning root) for cwd and every parent up to the git root; Grok loads each level."""
    if not cwd:
        return []
    cwd = os.path.normpath(cwd)
    if not git_root or not under(cwd, git_root):
        dirs = [cwd]
    else:
        dirs = []
        d, top = cwd, os.path.normpath(git_root)
        while True:
            dirs.append(d)
            parent = os.path.dirname(d)
            if os.path.normcase(d) == os.path.normcase(top) or parent == d:
                break
            d = parent
    return [(os.path.join(d, ".grok", "skills"), d) for d in dirs]


def collect_surfaces(grok_home: str, sessions: list[dict]) -> dict:
    skills = []

    def add_skills(glob_dir: str, source: str, extra: dict | None = None):
        if not os.path.isdir(glob_dir):
            return
        for d in sorted(os.listdir(glob_dir)):
            p = os.path.join(glob_dir, d, "SKILL.md")
            if os.path.isfile(p):
                rec = {"path": p, "source": source, **frontmatter(p)}
                if extra:
                    rec.update(extra)
                skills.append(rec)

    user_skills_dir = os.path.join(grok_home, "skills")
    add_skills(user_skills_dir, "user")
    agents_dir = os.path.expanduser("~/.agents/skills")
    if os.path.isdir(agents_dir) and os.path.realpath(agents_dir) != os.path.realpath(user_skills_dir):
        add_skills(agents_dir, "user")

    # every .grok/skills from a session's cwd up to its git root is a loaded project surface;
    # worktrees of one repo share the same tree, so keep one entry per skill name
    skill_dirs: dict[str, tuple[str, str]] = {}
    user_dirs = {os.path.realpath(user_skills_dir), os.path.realpath(agents_dir)}
    for s in sessions:
        for d, owner in project_skill_dirs(s.get("cwd") or "", s.get("git_root") or ""):
            if os.path.isdir(d) and os.path.realpath(d) not in user_dirs:
                skill_dirs.setdefault(os.path.realpath(d), (d, owner))
    project_roots = sorted({owner for _, owner in skill_dirs.values()})
    project_seen: dict[str, dict] = {}
    for d, owner in sorted(skill_dirs.values()):
        before = len(skills)
        add_skills(d, "project", {"project_roots": [owner]})
        for rec in skills[before:]:
            first = project_seen.get(rec["name"])
            if first is None:
                rec["git_tracked"] = git_tracked(rec["path"], owner)
                project_seen[rec["name"]] = rec
            elif owner not in first["project_roots"]:
                first["project_roots"].append(owner)
        del skills[before:]
    skills.extend(project_seen.values())
    add_skills(os.path.join(grok_home, "bundled", "skills"), "bundled")

    config_text = ""
    cfg = os.path.join(grok_home, "config.toml")
    if os.path.isfile(cfg):
        with open(cfg, encoding="utf-8", errors="replace") as f:
            config_text = f.read()
    enabled = toml_string_array(config_text, "plugins", "enabled") or []
    disabled = toml_string_array(config_text, "plugins", "disabled") or []
    skills_disabled = toml_string_array(config_text, "skills", "disabled") or []

    plugins = []
    plugin_root = os.path.join(grok_home, "installed-plugins")
    installed_names = set()
    # registry.json maps install dirs to plugin names; the dir name is not always <name>-<hash>
    registry_names: dict[str, list[str]] = {}
    reg_path = os.path.join(plugin_root, "registry.json")
    if os.path.isfile(reg_path):
        try:
            for repo in (read_json(reg_path).get("repos") or {}).values():
                p = os.path.realpath(repo.get("path") or "")
                if p:
                    registry_names[p] = sorted((repo.get("plugins") or {}).keys())
        except (OSError, ValueError, AttributeError):
            pass
    if os.path.isdir(plugin_root):
        for d in sorted(os.listdir(plugin_root)):
            full = os.path.join(plugin_root, d)
            if not os.path.isdir(full):
                continue
            names = registry_names.get(os.path.realpath(full)) or [re.sub(r"-[0-9a-f]{8}$", "", d)]
            name = names[0]
            installed_names.update(names)
            state = "enabled" if name in enabled else "disabled" if name in disabled else "unlisted"
            plugin_skill_dir = os.path.join(full, "skills")
            before = len(skills)
            add_skills(plugin_skill_dir, "plugin", {"plugin": name, "plugin_state": state})
            hooks_dir = os.path.join(full, "hooks")
            plugins.append({
                "name": name,
                "dir": full,
                "state": state,
                "skill_count": len(skills) - before,
                "has_hooks": os.path.isdir(hooks_dir),
                "has_commands": os.path.isdir(os.path.join(full, "commands")),
            })
    enabled_missing = sorted(n for n in enabled if n not in installed_names)
    disabled_missing = sorted(n for n in disabled if n not in installed_names)

    mcp_sources: dict[str, list[str]] = {}
    for n in toml_subtables(config_text, "mcp_servers"):
        mcp_sources.setdefault(n, []).append("config.toml")
    settings = os.path.join(grok_home, "settings.json")
    if os.path.isfile(settings):
        try:
            for n in (read_json(settings).get("mcpServers") or {}):
                mcp_sources.setdefault(n, []).append("settings.json")
        except (OSError, ValueError):
            pass
    mcp = [{"name": n, "sources": srcs} for n, srcs in mcp_sources.items()]

    hooks = []
    hooks_dir = os.path.join(grok_home, "hooks")
    if os.path.isdir(hooks_dir):
        hooks = sorted(os.listdir(hooks_dir))

    workflows = []
    for sub, source in (("workflows", "user"), (os.path.join("bundled", "workflows"), "bundled")):
        d = os.path.join(grok_home, sub)
        if os.path.isdir(d):
            for fn in sorted(os.listdir(d)):
                if fn.endswith(".rhai"):
                    workflows.append({"name": fn[:-5], "source": source, "path": os.path.join(d, fn)})
    for root in project_roots:
        d = os.path.join(root, ".grok", "workflows")
        if os.path.isdir(d):
            for fn in sorted(os.listdir(d)):
                if fn.endswith(".rhai"):
                    workflows.append({"name": fn[:-5], "source": "project", "path": os.path.join(d, fn)})

    mru = []
    mru_path = os.path.join(grok_home, "slash-mru.json")
    if os.path.isfile(mru_path):
        try:
            mru = sorted((read_json(mru_path).get("by_command") or {}).keys())
        except (OSError, ValueError):
            pass

    disabled_names = set(skills_disabled)
    for s in skills:
        from_enabled_source = s["source"] != "plugin" or s.get("plugin_state") == "enabled"
        s["loaded"] = from_enabled_source and s["name"] not in disabled_names
        s["disabled_by_name"] = s["name"] in disabled_names
        # in-place edits to these are lost (bundle/plugin sync) or land in someone else's git history
        s["protected"] = (
            "plugin" if s["source"] == "plugin"
            else "bundled" if s["source"] == "bundled"
            else "git-tracked" if s["source"] == "project" and s.get("git_tracked") is not False
            else None
        )

    # which loaded skills mention each skill by name (deleting a referenced skill breaks the referrer)
    bodies = {}
    for s in skills:
        if s["loaded"]:
            try:
                with open(s["path"], encoding="utf-8", errors="replace") as f:
                    bodies[s["path"]] = f.read()
            except OSError:
                pass
    for s in skills:
        n = re.escape(s["name"])
        pat = re.compile(r"(`/?" + n + r"`|(?<![\w-])/" + n + r"(?![\w-])|skills/" + n + r"(?![\w-]))")
        s["referenced_by"] = sorted(
            {o["name"] for o in skills if o["loaded"] and o["path"] != s["path"]
             and o["path"] in bodies and pat.search(bodies[o["path"]])}
        )

    # name collisions: same skill name loaded from more than one place
    by_name = collections.defaultdict(list)
    for s in skills:
        if s["loaded"]:
            by_name[s["name"]].append(s["source"] + (":" + s["plugin"] if s["source"] == "plugin" else ""))
    collisions = {k: v for k, v in by_name.items() if len(v) > 1}

    return {
        "grok_home": grok_home,
        "user_skills_dir": user_skills_dir,
        "user_skills_dir_realpath": os.path.realpath(user_skills_dir),
        "project_roots": project_roots,
        "skills": skills,
        "skills_disabled_by_name": skills_disabled,
        "plugins": plugins,
        "plugins_enabled_but_not_installed": enabled_missing,
        "plugins_disabled_but_not_installed": disabled_missing,
        "mcp_servers": mcp,
        "hooks": hooks,
        "workflows": workflows,
        "slash_mru": mru,
        "skill_name_collisions": collisions,
    }


# ---------------------------------------------------------------- sessions


def text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for c in content:
            if isinstance(c, dict) and c.get("type") == "text":
                parts.append(c.get("text") or "")
            elif isinstance(c, str):
                parts.append(c)
        return "\n".join(parts)
    return ""


def human_turns(content) -> list[str]:
    txt = text_of(content)
    found = [m.strip() for m in USER_QUERY_RE.findall(txt)]
    return [t for t in found if t]


def scan_session(sess_dir: str, summary: dict, drop_patterns: list[re.Pattern]) -> dict | None:
    chat = os.path.join(sess_dir, "chat_history.jsonl")
    if not os.path.isfile(chat):
        return None
    turns: list[str] = []
    tools = collections.Counter()
    mcp_tools = collections.Counter()
    skill_loads = collections.Counter()
    skill_load_paths = {}
    slash = collections.Counter()
    paths_touched = collections.Counter()
    subagents = 0
    workflow_launches = 0
    parse_errors = 0
    dropped_turns = 0
    with open(chat, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                r = json.loads(line)
            except ValueError:
                parse_errors += 1
                continue
            if not isinstance(r, dict):
                parse_errors += 1
                continue
            t = r.get("type")
            if t == "user" and not r.get("synthetic_reason"):
                for q in human_turns(r.get("content")):
                    if any(p.search(q) for p in drop_patterns):
                        dropped_turns += 1
                        continue
                    turns.append(q)
                    for m in SLASH_RE.findall(q):
                        slash[m] += 1
            elif t == "assistant":
                for call in r.get("tool_calls") or []:
                    if not isinstance(call, dict):
                        continue
                    name = call.get("name") or ""
                    tools[name] += 1
                    try:
                        a = json.loads(call.get("arguments") or "{}")
                    except ValueError:
                        a = {}
                    if not isinstance(a, dict):
                        a = {}
                    if name == "use_tool":
                        tn = a.get("tool_name") or ""
                        mcp_tools[tn.split("__", 1)[0] if "__" in tn else tn] += 1
                    elif name == "spawn_subagent":
                        subagents += 1
                    elif name == "workflow":
                        workflow_launches += 1
                    target = a.get("target_file") or a.get("file_path") or a.get("path")
                    if isinstance(target, str) and target:
                        sm = SKILL_PATH_RE.search(target)
                        if sm:
                            skill_loads[sm.group(1)] += 1
                            skill_load_paths.setdefault(sm.group(1), target)
                        elif name in ("read_file", "write", "search_replace"):
                            paths_touched[target] += 1
    if not turns:
        return None
    # "hi" / "Test" sessions with no real tool use are smoke tests, not habits
    real_tools = sum(n for name, n in tools.items() if name != "send_feedback")
    smoke_test = real_tools == 0 and all(len(t.split()) < 3 for t in turns)

    info = summary.get("info") or {}
    cwd = info.get("cwd") or ""
    git_root = summary.get("git_root_dir") or ""
    base = git_root or cwd
    dirs = collections.Counter()
    for p, n in paths_touched.items():
        rel = p
        if base and under(p, base):
            rel = os.path.relpath(p, base)
        parts = [x for x in re.split(r"[\\/]+", rel) if x]
        key = "/".join(parts[:2]) if len(parts) > 2 else (parts[0] if parts else rel)
        dirs[key] += n

    return {
        "id": info.get("id") or os.path.basename(sess_dir),
        "cwd": cwd,
        "git_root": git_root,
        "branch": summary.get("head_branch") or "",
        "title": summary.get("generated_title") or "",
        "session_kind": summary.get("session_kind"),
        "created_at": summary.get("created_at"),
        "updated_at": summary.get("updated_at"),
        "model": summary.get("current_model_id"),
        "human_turns": len(turns),
        "dropped_turns": dropped_turns,
        "parse_errors": parse_errors,
        "smoke_test": smoke_test,
        "turns": [(lambda r: r[:TURN_CAP] + ("…" if len(r) > TURN_CAP else ""))(redact(t)) for t in turns],
        "slash_commands": dict(slash.most_common()),
        "skills_loaded": dict(skill_loads.most_common()),
        "skill_load_paths": skill_load_paths,
        "mcp_servers_used": dict(mcp_tools.most_common()),
        "tools": dict(tools.most_common(25)),
        "subagent_spawns": subagents,
        "workflow_launches": workflow_launches,
        "top_dirs_touched": dict(dirs.most_common(10)),
        "trace_path": chat,
    }


def normalize(s: str) -> str:
    return WORD_RE.sub(" ", s.strip().lower())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--grok-home", default=os.environ.get("GROK_HOME") or os.path.expanduser("~/.cook"))
    ap.add_argument("--out", default=None, help="run directory to create (default: <GROK_HOME>/learn/runs/<UTC timestamp>, or <OS temp dir>/learn/estimate with --estimate)")
    ap.add_argument("--days", type=int, default=0, help="only sessions updated in the last N days (0 = all)")
    ap.add_argument("--since-last", action="store_true", help="only sessions updated after the last /learn run (GROK_HOME/learn/state.json)")
    ap.add_argument("--include-headless", action="store_true", help="keep session_kind=headless (bots, grok -p)")
    ap.add_argument("--include-subagents", action="store_true", help="keep subagent sessions (normally noise)")
    ap.add_argument("--cwd", action="append", default=[], help="keep only sessions whose cwd starts with this (repeatable)")
    ap.add_argument("--exclude-cwd", action="append", default=None, help="drop sessions whose cwd is under this (repeatable; default: the OS temp dirs)")
    ap.add_argument("--drop-pattern", action="append", default=[], help="regex; human turns matching it are dropped (scheduler templates, canaries)")
    ap.add_argument("--min-turns", type=int, default=1, help="minimum kept human turns per session")
    ap.add_argument("--session-id", action="append", default=[], help="only these session ids (repeatable)")
    ap.add_argument("--limit", type=int, default=0, help="keep only the N most recently updated sessions (0 = no limit)")
    ap.add_argument("--estimate", action="store_true", help="scan everything, write only <out>/estimate.json with per-scope session counts, agents, tokens, minutes; touch nothing else")
    ap.add_argument("--batch", type=int, default=10, help="sessions per mapper for the estimate (10, or 1 for --per-trace)")
    args = ap.parse_args()
    if args.batch < 1:
        ap.error("--batch must be at least 1")

    grok_home = os.path.abspath(os.path.expanduser(args.grok_home))
    sessions_root = os.path.join(grok_home, "sessions")
    if not os.path.isdir(sessions_root):
        log(f"no sessions directory at {sessions_root}")
        return 2
    if args.out:
        out = os.path.abspath(os.path.expanduser(args.out))
    else:
        stamp = "estimate" if args.estimate else dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S")
        # under GROK_HOME, not the OS temp dir: Windows' Storage Sense and the Temp cleaner delete a run's report
        # from %TEMP% before the user has curated it; the collector prunes runs older than 30 days itself
        out = os.path.join(grok_home, "learn", "runs", stamp)
        prune_old_runs(os.path.join(grok_home, "learn", "runs"), keep_days=30)
    stale_workflow = retire_stale_workflow_copy(grok_home)
    # the run dir holds the user's prompts; keep it owner-only where the OS supports it
    os.makedirs(out, exist_ok=True)
    try:
        os.chmod(out, 0o700)
    except OSError:
        pass
    if not args.estimate:
        os.makedirs(os.path.join(out, "sessions"), exist_ok=True)
        for sub in ("map", "reduce", "verify"):
            os.makedirs(os.path.join(out, sub), exist_ok=True)

    exclude_cwd = args.exclude_cwd if args.exclude_cwd is not None else DEFAULT_EXCLUDE_CWD
    drop_patterns = [re.compile(p, re.I) for p in DEFAULT_DROP_PATTERNS + args.drop_pattern]
    if args.estimate:
        args.days, args.since_last, args.limit = 0, False, 0
    cutoff = None
    if args.days > 0:
        cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=args.days)
    state_path = os.path.join(grok_home, "learn", "state.json")
    if args.since_last:
        # count from the last run whose curation finished; an orphaned run must not hide its sessions
        try:
            cutoff = parse_time(read_json(state_path).get("last_completed_at"))
        except (OSError, ValueError):
            cutoff = None
        if cutoff is None:
            log("--since-last: no completed run recorded; scanning everything")
    only_ids = set(args.session_id)

    seen = 0
    dropped = collections.Counter()
    kept: list[dict] = []
    for enc_cwd in sorted(os.listdir(sessions_root)):
        cwd_dir = os.path.join(sessions_root, enc_cwd)
        if not os.path.isdir(cwd_dir):
            continue
        for sid in sorted(os.listdir(cwd_dir)):
            sess_dir = os.path.join(cwd_dir, sid)
            summ_path = os.path.join(sess_dir, "summary.json")
            if not os.path.isdir(sess_dir):
                continue
            seen += 1
            if not os.path.isfile(summ_path):
                dropped["no_summary"] += 1
                continue
            if only_ids and sid not in only_ids:
                dropped["not_in_session_id_list"] += 1
                continue
            try:
                summary = read_json(summ_path)
            except (OSError, ValueError):
                dropped["summary_unreadable"] += 1
                continue
            if not isinstance(summary, dict):
                dropped["summary_unreadable"] += 1
                continue
            kind = summary.get("session_kind")
            if kind in SUBAGENT_KINDS and not args.include_subagents:
                dropped["subagent"] += 1
                continue
            if kind == "headless" and not args.include_headless:
                dropped["headless"] += 1
                continue
            cwd = (summary.get("info") or {}).get("cwd") or urllib.parse.unquote(enc_cwd)
            if any(under(cwd, p) for p in exclude_cwd) or any(s in cwd for s in DEFAULT_EXCLUDE_SUBSTR):
                dropped["excluded_cwd"] += 1
                continue
            if args.cwd and not any(under(cwd, p) for p in args.cwd):
                dropped["outside_cwd"] += 1
                continue
            if cutoff is not None:
                ts = parse_time(summary.get("updated_at"))
                if ts is None or ts < cutoff:
                    dropped["older_than_window"] += 1
                    continue
            rec = scan_session(sess_dir, summary, drop_patterns)
            if rec is None or rec["human_turns"] < args.min_turns:
                dropped["no_human_turns"] += 1
                continue
            if rec["smoke_test"]:
                dropped["smoke_test"] += 1
                continue
            kept.append(rec)

    kept.sort(key=lambda r: r.get("updated_at") or "", reverse=True)

    if args.estimate:
        now = dt.datetime.now(dt.timezone.utc)
        try:
            st = read_json(state_path)
        except (OSError, ValueError):
            st = {}
        since = parse_time(st.get("last_completed_at"))

        def in_window(r, cut):
            ts = parse_time(r.get("updated_at"))
            return ts is not None and ts >= cut

        windows = {
            "all": kept,
            "30d": [r for r in kept if in_window(r, now - dt.timedelta(days=30))],
            "14d": [r for r in kept if in_window(r, now - dt.timedelta(days=14))],
            "quick": kept[:25],
        }
        if since is not None:
            windows["since_last"] = [r for r in kept if in_window(r, since)]
        est = {name: estimate(len(rows), args.batch) for name, rows in windows.items()}
        for name, rows in windows.items():
            est[name]["flags"] = {"all": [], "30d": ["--days", "30"], "14d": ["--days", "14"], "quick": ["--limit", "25"],
                                  "since_last": ["--since-last"]}[name]
        if since is not None and est["since_last"]["sessions"] > 0:
            recommended = "since_last"
        elif len(kept) > 100:
            recommended = "14d"
        else:
            recommended = "all"
        result = {"grok_home": grok_home, "out": out, "generated_at": now.isoformat(timespec="seconds"), "sessions_seen": seen,
                  "dropped": dict(dropped), "batch": args.batch, "last_completed_at": st.get("last_completed_at"),
                  "windows": est, "recommended": recommended,
                  "note": "tokens are a calibrated estimate (about +/-50%); minutes are a range calibrated on real runs of 23-66 minutes, growing slowly with session count"}
        with open(os.path.join(out, "estimate.json"), "w", encoding="utf-8") as f:
            json.dump(result, f, indent=1)
        log(f"seen={seen} kept(all)={len(kept)} batch={args.batch}")
        for name in ("since_last", "quick", "14d", "30d", "all"):
            if name in est:
                e = est[name]
                log(f"  {name:<10} sessions={e['sessions']:>4} agents={e['agents']:>3} tokens~{e['tokens_m']:>5}M  minutes~{e['minutes'][0]}-{e['minutes'][1]}{'  (recommended)' if name == recommended else ''}")
        print(json.dumps(result))
        return 0

    if args.limit > 0 and len(kept) > args.limit:
        dropped["beyond_limit"] += len(kept) - args.limit
        kept = kept[: args.limit]

    # sessions that are one identical prompt repeated across sessions look like automation
    single = collections.Counter(normalize(r["turns"][0]) for r in kept if r["human_turns"] == 1)
    for r in kept:
        r["repeated_single_turn"] = bool(r["human_turns"] == 1 and single[normalize(r["turns"][0])] >= 3)

    for i, r in enumerate(kept):
        r["index"] = i
        with open(os.path.join(out, "sessions", f"{i:04d}-{r['id']}.json"), "w", encoding="utf-8") as f:
            json.dump(r, f, indent=1, ensure_ascii=False)

    surfaces = collect_surfaces(grok_home, kept)
    project_roots = surfaces["project_roots"]
    with open(os.path.join(out, "surfaces.json"), "w", encoding="utf-8") as f:
        json.dump(surfaces, f, indent=1, ensure_ascii=False)

    # usage per surface item, deterministic
    def hit_record():
        return {"count": 0, "sessions": [], "last_used": None, "via": collections.Counter()}

    usage = collections.defaultdict(hit_record)

    def hit(key, r, n, via):
        u = usage[key]
        u["count"] += n
        if r["id"] not in u["sessions"] and len(u["sessions"]) < 8:
            u["sessions"].append(r["id"])
        if (r.get("updated_at") or "") > (u["last_used"] or ""):
            u["last_used"] = r.get("updated_at")
        u["via"][via] += n

    skill_names = {s["name"] for s in surfaces["skills"]}
    for r in kept:
        for name, n in r["skills_loaded"].items():
            hit(("skill", name), r, n, "skill_file_read")
        for name, n in r["slash_commands"].items():
            if name in skill_names or any(w["name"] == name for w in surfaces["workflows"]):
                hit(("skill" if name in skill_names else "workflow", name), r, n, "slash")
        for name, n in r["mcp_servers_used"].items():
            hit(("mcp", name), r, n, "use_tool")
        for w in surfaces["workflows"]:
            if r["workflow_launches"] and any(w["name"] in t for t in r["turns"]):
                hit(("workflow", w["name"]), r, 1, "mention")

    items = []
    for s in surfaces["skills"]:
        u = usage.get(("skill", s["name"]))
        items.append({
            "kind": "skill", "name": s["name"], "source": s["source"], "path": s["path"],
            "protected": s["protected"], "referenced_by": s["referenced_by"],
            "plugin": s.get("plugin"), "plugin_state": s.get("plugin_state"),
            "loaded": s["loaded"], "disabled_by_name": s["disabled_by_name"],
            "in_slash_mru": s["name"] in surfaces["slash_mru"],
            "count": u["count"] if u else 0, "sessions": u["sessions"] if u else [],
            "last_used": u["last_used"] if u else None, "via": dict(u["via"]) if u else {},
        })
    for p in surfaces["plugins"]:
        n = sum(i["count"] for i in items if i.get("plugin") == p["name"])
        sess = []
        for i in items:
            if i.get("plugin") == p["name"]:
                for sid in i["sessions"]:
                    if sid not in sess and len(sess) < 8:
                        sess.append(sid)
        items.append({"kind": "plugin", "name": p["name"], "state": p["state"], "path": p["dir"],
                      "skill_count": p["skill_count"], "count": n, "sessions": sess})
    for m in surfaces["mcp_servers"]:
        u = usage.get(("mcp", m["name"]))
        items.append({"kind": "mcp", "name": m["name"], "sources": m["sources"],
                      "count": u["count"] if u else 0, "sessions": u["sessions"] if u else [],
                      "last_used": u["last_used"] if u else None})
    for w in surfaces["workflows"]:
        u = usage.get(("workflow", w["name"]))
        items.append({"kind": "workflow", "name": w["name"], "source": w["source"], "path": w["path"],
                      "count": u["count"] if u else 0, "sessions": u["sessions"] if u else []})
    for h in surfaces["hooks"]:
        items.append({"kind": "hook", "name": h, "count": None, "note": "hook use is not visible in chat_history; judge by config only"})

    unknown_slash = collections.Counter()
    for r in kept:
        for name, n in r["slash_commands"].items():
            if name not in skill_names and name not in SLASH_STOP and not any(w["name"] == name for w in surfaces["workflows"]):
                unknown_slash[name] += n
    configured_mcp = {m["name"] for m in surfaces["mcp_servers"]}
    mcp_unconfigured = {k[1]: u["count"] for k, u in usage.items() if k[0] == "mcp" and k[1] not in configured_mcp}

    with open(os.path.join(out, "usage.json"), "w", encoding="utf-8") as f:
        json.dump({
            "kept_sessions": len(kept),
            "items": items,
            "unused_loaded": [i for i in items if i["kind"] == "skill" and i["loaded"] and i["count"] == 0 and not i["in_slash_mru"]],
            "slash_commands_with_no_loaded_skill": dict(unknown_slash.most_common()),
            "mcp_servers_used_but_not_in_local_config": mcp_unconfigured,
            "note": "hooks and managed-gateway MCP servers are not visible in local config; count is None when it cannot be measured",
        }, f, indent=1, ensure_ascii=False)

    # repeated phrases
    exact = collections.defaultdict(list)
    stems = collections.defaultdict(list)
    lines = collections.defaultdict(set)
    for r in kept:
        if r["repeated_single_turn"]:
            continue
        for t in r["turns"]:
            n = normalize(t)
            if len(n) < 12:
                continue
            if SLASH_RE.fullmatch(t.strip()) or re.fullmatch(r"/[a-z0-9-]+(\s+\S+){0,3}", n):
                continue
            exact[n].append(r["id"])
            words = n.split(" ")
            if len(words) >= 6:
                stems[" ".join(words[:12])].append(r["id"])
            for ln in t.splitlines():
                ln_n = normalize(ln)
                if len(ln_n.split(" ")) >= 5 and len(ln_n) >= 24:
                    lines[ln_n].add(r["id"])

    def top(d, min_count, key_name, distinct_sessions=True):
        rows = []
        for k, ids in d.items():
            ids = list(ids)
            c = len(set(ids)) if distinct_sessions else len(ids)
            if c >= min_count:
                rows.append({key_name: k[:400], "sessions": c, "occurrences": len(ids), "session_ids": sorted(set(ids))[:8]})
        rows.sort(key=lambda x: (-x["sessions"], -x["occurrences"]))
        return rows[:60]

    with open(os.path.join(out, "phrases.json"), "w", encoding="utf-8") as f:
        json.dump({
            "exact_prompts": top(exact, 2, "phrase"),
            "prompt_stems_12_words": top(stems, 3, "stem"),
            "repeated_instruction_lines": top(lines, 3, "line"),
            "note": "counts are distinct sessions; single-turn sessions repeated 3+ times are excluded as likely automation",
        }, f, indent=1, ensure_ascii=False)

    decisions_src = os.path.join(grok_home, "learn", "decisions.jsonl")
    if os.path.isfile(decisions_src):
        shutil.copyfile(decisions_src, os.path.join(out, "decisions.jsonl"))

    # zero hits only mean disuse when the window is wide: every cwd, at least 20 sessions, at least 7 days
    kept_times = sorted(t for t in (parse_time(r.get("updated_at")) for r in kept) if t)
    span_days = (kept_times[-1] - kept_times[0]).total_seconds() / 86400 if len(kept_times) >= 2 else 0.0
    narrow = []
    if args.cwd:
        narrow.append("scoped to one working directory")
    if args.session_id:
        narrow.append("scoped to listed sessions")
    if len(kept) < 20:
        narrow.append(f"only {len(kept)} sessions kept")
    if span_days < 7:
        narrow.append(f"sessions span {span_days:.1f} days")
    disuse_evidence = {"sufficient": not narrow, "span_days": round(span_days, 1), "reason": "; ".join(narrow) or "every working directory, %d sessions over %.0f days" % (len(kept), span_days)}

    manifest = {
        "grok_home": grok_home,
        "run_dir": out,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "disuse_evidence": disuse_evidence,
        "stale_workflow_copy": stale_workflow,
        "params": {
            "days": args.days, "since_last": args.since_last, "cutoff": cutoff.isoformat() if cutoff else None,
            "include_headless": args.include_headless,
            "include_subagents": args.include_subagents, "cwd": args.cwd,
            "exclude_cwd": exclude_cwd, "drop_patterns": args.drop_pattern, "min_turns": args.min_turns,
            "session_ids": args.session_id, "limit": args.limit,
        },
        "estimate": estimate(len(kept), args.batch),
        "sessions_seen": seen,
        "sessions_kept": len(kept),
        "dropped": dict(dropped),
        "human_turns_total": sum(r["human_turns"] for r in kept),
        "repeated_single_turn_sessions": sum(1 for r in kept if r["repeated_single_turn"]),
        "project_roots": project_roots,
        "kept": [{"index": r["index"], "id": r["id"], "cwd": r["cwd"], "turns": r["human_turns"], "updated_at": r["updated_at"], "title": r["title"]} for r in kept],
        "prior_decisions": os.path.isfile(decisions_src),
    }
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1, ensure_ascii=False)

    # a new collection starts a new pending run; state.py moves it through running -> report_ready -> done
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    try:
        state = read_json(state_path)
    except (OSError, ValueError):
        state = {}
    state.update({"last_run_at": manifest["generated_at"], "last_run_dir": out, "sessions_kept": len(kept)})
    if kept:
        state["pending"] = {"run_dir": out, "status": "collected", "started_at": manifest["generated_at"],
                            "updated_at": manifest["generated_at"], "report_ready": False}
    with open(state_path, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=1)

    log(f"seen={seen} kept={len(kept)} dropped={dict(dropped)} turns={manifest['human_turns_total']}")
    log(f"surfaces: skills={len(surfaces['skills'])} plugins={len(surfaces['plugins'])} mcp={len(surfaces['mcp_servers'])} hooks={len(surfaces['hooks'])} workflows={len(surfaces['workflows'])}")
    log(f"unused loaded skills={len([i for i in items if i['kind']=='skill' and i['loaded'] and i['count']==0 and not i['in_slash_mru']])}")
    print(json.dumps({"run_dir": out, "kept": len(kept), "seen": seen, "dropped": dict(dropped), "stale_workflow_copy": stale_workflow}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
