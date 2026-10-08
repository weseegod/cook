---
name: learn
description: >-
  Learn from your own Grok Build sessions and tune your setup: add skills for
  things you keep typing, fix stale skill instructions, and retire skills,
  plugins, or MCP servers you never use. Use on "/learn", "learn from my
  traces", "what skills do I never use". Not for summarizing sessions into
  notes or memory.
user-invocable: true
argument-hint: "[--mode step|auto|report] [--days N | --since-last | --limit N] [--per-trace] [--include-headless] [--cwd PATH] [--focus TEXT] [--resume]"
---

# learn

Read the sessions this user sat at, find what they repeat, correct, and never use, and change the harness so the next session needs less typing. Every path derives from `GROK_HOME` (default `~/.cook`); nothing here names a person, repo, or cloud.

```
You (top-level agent)
│
├── 0. state.py get → resume a pending run; collect_sessions.py --estimate → price per scope;
│      read the user's wording → decide, or ask mode + scope once with the price on each option
├── 1. collect_sessions.py  → <run>/sessions/*.json, surfaces.json, usage.json, phrases.json   (deterministic, seconds)
├── 2. workflow learn-traces.rhai                                            (background; minutes from the estimate)
│      Map     one agent per batch of sessions → map/<range>.md   (signals.md §1,2,3,5)
│      Reduce  one agent per 10 notes, repeated until one synthesis remains, skill files open as context
│      Verify  three skeptics: phrases, stale lines, deletes — keep or drop, add nothing
│      Report  report.md + actions.json, then state.py → report_ready         (report-format.md)
├── 3. Short version in chat
└── 4. Curate with the user → apply → decisions.jsonl → state.py → done
```

Files next to this SKILL.md: `collect_sessions.py`, `state.py`, `learn-traces.rhai` (the workflow; a copy also ships under the bundle's `workflows/`), `signals.md` (what to look for, ordered by blast radius), `report-format.md` (shape of `report.md` and `actions.json`).

Host commands must work in bash **and** PowerShell: no `mkdir -p`, `mv`, `chmod`, `rm`, `date`, `echo >>`, no writing to `/tmp`, and no hard-coded interpreter name; the two Python helpers do all filesystem work. Once per session, probe for an interpreter by running `state.py get` with `python`, then `py -3`, then `python3`; the first that prints JSON (exit code 0, or 3 when a run is pending) is the one to use. Its `python` field is the interpreter's absolute path and its `grok_home` field is the resolved home; use those two values as `<PYTHON>` and `<GROK_HOME>` in every later command and in the workflow `args`, always double-quoted (paths may contain spaces), and do not rely on a shell variable surviving between commands. If none of the three runs, tell the user to install Python 3 and stop. Placeholders: `<skill dir>` is the directory holding this SKILL.md; `<user skills dir>` is `user_skills_dir` from `surfaces.json` (normally `<GROK_HOME>/skills`); `<RUN>` is the run directory the collector prints; `<run name>` is its last path component (for example `20260909-174034`).

If the user asked to summarize learnings into memory or notes rather than change skills, do not run this skill; use the memory tools and say why.

## 0. Resume or set up

The `state.py get` call above is also the resume check. Exit code 3 means a run is pending; `pending.run_dir` is its directory and `pending.status` says where it stopped:

- `report_ready` or `curating` — the report exists but was never curated (the user left, or the session ended). Tell the user the run date, the session count, and the action count from `<run_dir>/actions.json`, and offer to resume at step 3 instead of collecting again. `decisions.jsonl` lines already written for that run are respected.
- `running` with no `report.md` — the workflow was interrupted (closing the TUI stops it). Offer two choices: read the partial synthesis (the newest file under `<run_dir>/reduce/` if any, else the `map/*.md` notes) and stop, or start a fresh run.
- `collected` — sessions were collected but the workflow never launched. Offer to launch it (skip to step 2 with that run dir) or start fresh.
- `--resume` takes the first offer in each case without asking.

For a new run, price it before deciding anything:

```bash
<PYTHON> <skill dir>/collect_sessions.py --estimate [--batch 1]
```

It scans everything in about a second and writes `estimate.json` (its `out` field is the path): for each scope (`all`, `30d`, `14d`, `quick` = the 25 most recent sessions, `since_last` when a completed run exists) the kept session count, agent count, estimated tokens, and a wall-time range, plus a `recommended` scope (`since_last` when it has sessions; otherwise `14d` above 100 sessions, else `all`). Tokens are calibrated on real runs to roughly ±50% (a 25-session run is about 9M, a 200-session run about 30M, `--per-trace` about doubles it); the minutes range is the only wall-time figure to quote. If every scope has 0 sessions, tell the user there is nothing to learn from yet and stop.

Then read what the user typed and pick one of three paths. Depth words and go words combine ("just run it, quick" = `auto` + `quick`); explicit flags (`--mode`, `--days`, `--limit`, `--since-last`, `--per-trace`) win over wording. Two rules override both wording and flags: a first-ever run (no `last_completed_at` in `estimate.json`) is always `step`, because `auto` removes zero-use skills and the user has never seen a report; and above 40M estimated tokens, ask the neutral-path question below before launching.

- **They told you to go.** Wording like "just run it", "go ahead", "don't ask", "auto", "you decide" → mode `auto`, scope = the recommended one. Do not ask about mode or scope — but never skip the price: print the estimate line (sessions, ~tokens, minutes) before the collector runs. If the recommended scope prices above 10M tokens, "auto" still gets one question — "this will use ~N tokens, go?" — because a user who said "go" without seeing a number has not agreed to that number; users have cancelled 16M-token auto runs within a minute of seeing the first agent start.
- **They told you the depth.** "quick", "cheap", "light", "a taste" → `quick`; "everything", "all of it", "deep", "thorough" → `all`; "per trace", "every session on its own" → `--per-trace`; "since last time", "what's new" → `since_last`. Mode stays `step` unless they also said to go. State the price in one line.
- **Neutral** (bare `/learn`, "learn from my traces") → ask once with a single `ask_user_question` of exactly two questions, then do not ask again until curation:
  - **Mode** — `step` (recommended): present each group of actions and apply what the user picks. `auto`: apply every reversible action, then ask once about the rest. `report`: write the report, change nothing.
  - **Scope** — one option per scope in `estimate.json`, each labeled with its price, for example "Since last run — 12 sessions, ~7M tokens, ~25–45 min (recommended)", "Last 14 days — 58 sessions, ~11M tokens", "Quick look — 25 most recent, ~9M tokens", "Everything — 206 sessions, ~33M tokens". Mark the recommended one. Headless bot sessions stay out unless the user passes `--include-headless`; say so in the option text rather than asking a third question.

If the user dismisses the question, ask the same two things in one plain-text line ("reply like `step, since-last`") and take exactly what they type. If `ask_user_question` errors, retry once, then use the same plain-text fallback; the tool exists in every Grok Build session.

`--per-trace` runs one map agent per session (most thorough, about twice the tokens; default is batches of 10). `--limit N` keeps the N most recent sessions. `--focus TEXT` is a free-text lens for mappers and reducers; it cannot remove a report section. `--cwd PATH` limits collection to one working directory.

**Unattended runs** (`/loop 24h /learn`, a scheduled task, `grok -p "/learn"`): nobody will answer a question, so use `--mode report --since-last` unless told otherwise, skip the setup question, still print the coverage and price, and block on `state.py wait` as step 2 requires. Leave the report for the next interactive `/learn`, which offers to resume curation from it (step 0). A first-ever unattended run has no `last_completed_at`, so `--since-last` scans everything; that is the one time the estimate can exceed the 40M guard — respect it and stop rather than ask.

Traces from another machine: copy that machine's `sessions/` tree into a directory of its own and run the collector against it with `--grok-home`; the workflow reads the run directory, not the machine.

## 1. Collect

```bash
<PYTHON> <skill dir>/collect_sessions.py [--days N | --since-last | --limit N] [--batch 1] [--include-headless] [--cwd PATH] [--drop-pattern REGEX]
```

The collector picks the run directory itself (`<GROK_HOME>/learn/runs/<UTC timestamp>` — not the OS temp dir, which Windows sweeps before the user has curated the report; the collector deletes runs older than 30 days) and prints it as `run_dir` in its last stdout line; use that value as `<RUN>` everywhere below.

A session is kept when the user sat at it: not `subagent*`, not `headless` unless included, not started under the OS temp directories or an e2e fixture, at least one real human prompt (`<user_query>` on a user record without `synthetic_reason`), and not a one-word smoke test with no tool use. `--drop-pattern` removes automation prompts (scheduler templates, canaries); the TUI's `/feedback` template is dropped by default. Pasted credentials are redacted before anything is written.

Outputs in `<RUN>`: `manifest.json` (params, counts, `dropped` by reason, kept list), `sessions/NNNN-<id>.json` (human `turns`, `slash_commands`, `skills_loaded`, `mcp_servers_used`, `tools`, `top_dirs_touched`, cwd, git root, title, model), `surfaces.json` (every skill, plugin, MCP server, hook, and workflow that exists — user, every `.grok/skills` from a session's cwd up to its git root, bundled, plugin — names and paths only, with `loaded`, `protected` (plugin, bundled, git-tracked), `referenced_by`, and `skill_name_collisions`), `usage.json` (deterministic hit counts, `unused_loaded`), `phrases.json` (prompts and instruction lines repeated across sessions), and `decisions.jsonl` (prior decisions, if any). The collector records the run as `pending: collected` in `GROK_HOME/learn/state.json`.

If `sessions_kept` is under 5, do not launch: the fixed cost of the reduce, verify, and report agents (~5M tokens) buys almost nothing from so few sessions, and a narrow window cannot support any retirement anyway — say so in one line and offer the next wider scope from `estimate.json`. `manifest.json` carries `estimate` for the chosen scope (agents, tokens, minutes); use those numbers, not a guess. Tell the user the coverage line (`seen`, `kept`, `dropped` by reason) **before** launching, and say plainly that the prompts from those N sessions will be sent to the model as part of the run. If `kept` is 0, fix the scope before going on. A skill counts as used when its SKILL.md was read or its slash command appears in a prompt; a skill that lives outside the scanned roots shows up under `slash_commands_with_no_loaded_skill`, which means "not found", not "no skill exists".

## 2. Map-reduce

Check the available workflows list. If `learn-traces` is listed, launch with `source = {type: "name", name: "learn-traces"}`. A user-level copy at `<GROK_HOME>/workflows/learn-traces.rhai` shadows the bundled workflow of the same name; the collector already moved any stale one to `<GROK_HOME>/learn/trash/` and reported it as `stale_workflow_copy` in its last stdout line — if that field is non-null, tell the user in one line that an old copy was retired. Never launch through such a copy by `script_path` while the named workflow is available. If `learn-traces` is not listed (older clients do not install bundled workflows), read `<skill dir>/learn-traces.rhai` with the file tools, write it to `<GROK_HOME>/workflows/learn-traces.rhai` (the `workflow` tool trusts only that directory), and launch with `source = {type: "script_path", script_path: "<GROK_HOME>/workflows/learn-traces.rhai"}`; that copy must be refreshed from `<skill dir>` on every launch, not reused. If `<skill dir>/learn-traces.rhai` does not exist either, or `collect_sessions.py` is missing from `<skill dir>`, stop and tell the user their Grok Build install did not receive the full skill and to update; do not reconstruct the workflow from memory, the web, or the binary.

The script cannot read the parent conversation, so everything goes in `args = {run_dir: <RUN>, count: manifest.sessions_kept, skill_dir: <skill dir>, grok_home: <GROK_HOME>, python: <PYTHON>, batch: 10 (1 for --per-trace), fan: 10, today: "<YYYY-MM-DD>", user_label: "<name or 'the user'>", focus: "<text or omit>"}`. The script computes the agents it needs (`ceil(count/batch)` mappers, about a tenth as many reducers per round, 3 verifiers, 1 reporter), logs the number, and pauses if `agent_budget` is short; per-trace runs over ~110 sessions need a budget above the default 128.

Before launching, tell the user three things in one short message: the coverage line; the price from `manifest.json` → `estimate` (sessions, agents, ~tokens, and the minutes range as given — time grows slowly with session count because mappers run in parallel); and that the run lives in this Grok session, so closing the TUI stops it, while leaving the session idle is fine. Then run `<PYTHON> <skill dir>/state.py set --run-dir <RUN> --status running --mode <mode> --scope <scope>`.

**Launch, then block.** The workflow runs inside your session and dies with the turn that launched it when that turn is the whole session — a headless `grok -p`, a `/loop` fire, a scheduled task, or a subagent. Ending your turn on "the run notifies me when done" kills the run at the next phase boundary. So, immediately after the `workflow` call, run `<PYTHON> <skill dir>/state.py wait --run-dir <RUN> --timeout-min <estimate minutes high + 30>` as a background command and block on its completion before you say or do anything else; it prints the phase as it changes, records the run as `report_ready` in `state.json` when `report.md` and `actions.json` exist and exits 0, or exits 2 on timeout. Only this parent session writes `state.json`: a worker that writes outside the run directory can hit a permission prompt that nobody is there to answer, and the run then sits at the Report stage forever. In an interactive TUI this costs nothing (the wait is what the user would do anyway); everywhere else it is the difference between a report and 13 orphaned mappers. If `wait` exits 2, read `<RUN>/map*.md`, `reduce`, and `verify` for partial output, set the state to `running` with a note, and tell the user what finished. If the `workflow` tool is not in your tool list, you are a subagent: stop and report that `/learn` must run from the top-level agent; do not launch through any other mechanism.

**If `wait` exits 3 (`report_stalled`)**, the verifiers finished but the report step produced nothing for 45 minutes. First check whether the run is still alive: the workflow host lists active runs (`/workflow runs`, or the run's completion notice has not arrived). If the report agent is still running, the report is slow, not stalled — large runs on Windows take 30–40 minutes for this step — so run `wait` again with `--report-stall-min 60` and say so. Only when the run has ended without writing the files (the completion notice arrived, or the host shows no active run) treat it as stalled: do not relaunch the whole run. Read the `synthesis` path `wait` printed (the final reducer output: sections 1–4 plus Dropped) and the three files in `<RUN>/verify`, present the synthesis's sections 1–3 to the user as the findings — kept claims only, trimmed to the top rows, marked "unverified report step" — and, if the run ended in failure rather than completing, offer one retry of the report step alone: `workflow` tool with `source: {type: "resume", resume_from_run_id: <the run id>}` — the run's journal already holds the map, reduce, and verify results, so the resume replays them and re-issues only the report agent (a run that the host reports as complete cannot be resumed or paused; a new launch with the same args would redo everything and is not worth it). If the retry stalls too, stop there: the synthesis is the result, and the user can curate from it by hand. Never write `report.md` yourself from the synthesis — a report the verifiers did not gate must not feed the apply step.

**If the host reports the run paused with an "infra" reason** (every agent in a map wave failed at once), the user's usage balance is exhausted or the API is down; the workflow has already stopped spending. Say so in one line, tell the user the run resumes from where it stopped — `workflow` tool, `source: {type: "resume", resume_from_run_id: <run id>}` — once their balance resets, and end the turn. Do not relaunch, and do not run `state.py wait` again until they resume.

**If `wait` exits 4 (`phase_stalled`)**, nothing under the run directory has changed for an hour in whatever phase it was in (a 246-session reduce once sat five hours). Check the host's run list: if the run is gone, it died — treat like exit 3 (present what exists: the newest `reduce/*.md` if any, else the `map*.md` notes, marked unverified) and offer one `resume`. If the host still shows it running, it is wedged: stop it (`workflow` tool, `source: {type: "stop", run_id}`), then `resume` once — the journal replays finished agents and re-issues only the frozen one. Do not wait longer than one more `--phase-stall-min` on the resumed run.

If the user asks how it is going while the wait runs, list `<RUN>/map*.md`, `<RUN>/reduce`, and `<RUN>/verify` with the file tools and say which phase is writing.

Design rules the script keeps, for anyone editing it: control flow derives only from `args` and agent results; the work list comes from the collector, never from an agent; every artifact path is assigned by the script, never taken from an agent's text; every agent output is guarded and a failed slot is logged as lost; verification fails closed; verifiers append verdicts incrementally and cap their reading so one stuck agent cannot stall the run. Edit the copy under `GROK_HOME/workflows/`, smoke-check with `validate_only: true` and the same `args`, then launch. The Rhai dialect and host API are documented in the bundled `create-workflow` skill.

## 3. Present

Read `report.md`. Give the user the Overview (problem, proposed change, action counts), the three tables trimmed to their top rows, the Coverage line, and the path to the full report. Keep it under a screen; do not paste `actions.json`. If the report's headline names a skill as missing, check `slash_commands_with_no_loaded_skill` in `usage.json` first: the skill may exist in a root the collector did not scan, and the right action is to say so, not to create a duplicate.

**The report comes first, on its own.** Print that short version as a plain message and end the turn on it; the first `ask_user_question` of step 4 belongs to the next turn, after the user has had the report in view. Never open a picker in the turn that presents the report, and never open one without having presented it — a user who is asked "which of A1, A5, A7 should go?" before seeing what A1 is cannot give consent, whatever they pick. If the report proposes nothing to create or edit, say so; "no new skills" is a valid outcome, not a reason to jump to deletes.

## 4. Curate and apply

`actions.json` is the work list (fields in `report-format.md`). Consent rules, identical in every mode:

- An action is applied only when the user picked its id, or in `auto` mode when it is reversible and not `requires_confirmation`.
- A free-text answer ("Other", "just go", "fix the wording") is not consent. Re-ask with the literal reading as options ("edit existing skills only, create none?") before writing anything.
- Options the user left unpicked are recorded `deferred`, not `rejected`. Only an explicit refusal ("no", "reject", "keep", "none") is `rejected`. Deferred items return next run; rejected ones do not.
- One group's answer never authorizes another group. Ask per group even after "all" on the previous one.
- Before recording rejections, re-read the answer once: a single-item pick on a multi-select that offered many is the shape of an accidental Enter. Apply the pick, defer the rest, and say so.

Apply mechanics:

- `create` — write `edit.replacement` to `path` (`<user skills dir>/<name>/SKILL.md`), creating the directory.
- `edit` — before the first edit to any file in a run, read it and write an untouched copy to `<GROK_HOME>/learn/trash/<run name>/originals/<name>.md`; that copy is the undo and goes in `--undo`. Then `search_replace` on `path` with `edit.anchor` as the old string; `edit.mode` says how: `replace` swaps the anchor for `replacement`, `insert_after` keeps the anchor and adds `replacement` after it, `append` adds `replacement` at the end of the file. If the anchor is missing, re-read the file and fix the anchor; never overwrite the whole file.
- `propose` — the target is protected. For `plugin` or `bundled`: read the protected SKILL.md in full, apply `edit.anchor` → `edit.replacement` to that text, and write the **complete** result to `<user skills dir>/<name>/SKILL.md` (a user skill of the same name takes precedence over the bundled or plugin copy; a fragment would replace the whole skill with the fragment). For `git-tracked`: write the patch to `<RUN>/patches/<name>.diff` and tell the user it needs a pull request. Never edit a plugin, bundled, or git-tracked file in place: plugin and bundle syncs overwrite the first two, and the third lands in someone else's branch.
- `enable` / `disable` — edit only the `[plugins]` `enabled` and `disabled` lists in `GROK_HOME/config.toml`. Read only that block.
- `delete` — if `referenced_by` is non-empty, stop and ask, naming the referrers. Otherwise `<PYTHON> <skill dir>/state.py trash --run-name <run name> <path>` moves the skill directory, workflow file, or hook file into `<GROK_HOME>/learn/trash/<run name>/` (never the OS temp dir; it must survive a reboot) and prints where it went. For an MCP server in `config.toml`, cut its `[mcp_servers.<name>]` tables (with sub-tables) out with `search_replace`, write them with the `write` tool to `<GROK_HOME>/learn/trash/<run name>/mcp-<name>.toml`, then `<PYTHON> <skill dir>/state.py restrict <that file>`; never echo the contents. For an MCP server in `settings.json`, write the `mcpServers.<name>` object to `<GROK_HOME>/learn/trash/<run name>/mcp-<name>.json` and `restrict` it the same way **before** removing the key. Do not copy whole config files. Undo is moving the file or the table back.
- After each apply, re-read the changed file or config block and confirm the change is present.

By mode:

- **Narrow runs retire nothing.** Read `manifest.json` → `disuse_evidence` before group 3. When `sufficient` is `false` (the run was `--cwd`-scoped, kept fewer than 20 sessions, or spans under 7 days), skip group 3 entirely in every mode — apply no `delete`, `disable`, or `group` action even if the report emitted one — and tell the user in one line that zero hits in this window are not evidence of disuse and that retiring anything needs a run over every working directory. The "only copy of a job" rule below still applies when the window is wide.
- **step** — one `ask_user_question` per group: 1 (phrases → create/edit), 2 (updates), 3 (deletes/disables), then 4 (gaps, discussion only). `multi_select` over action ids with the quoted evidence in each option's description; at most eight options per question, so split larger groups; label `ask` and `propose` actions as such. Apply the picked ones before the next group, and write `deferred` for the unpicked ones the moment the group closes, so a user who goes silent leaves a complete ledger.
  A `kind: group` action (see `report-format.md`: several unused surfaces with the same disposition, bundled into one decision) is one question with three options, not one per item: **apply to all** (run the group's `action` on every item), **pick items** (expand into `multi_select` questions of at most eight items each), or **skip all** (defer). Record one `decide` line per item either way, with the group id in `--path` so a later run can tell the batch apart.
- **auto** — apply every action with `requires_confirmation: false`, then one question for the `requires_confirmation: true`, `ask`, and `propose` actions, then apply the picked ones.
- **report** — stop after step 3, then set the state to `done` so the next run's `since_last` counts from here.

Record every decision with `<PYTHON> <skill dir>/state.py decide --run-dir <RUN> --id A3 --kind skill --action delete --target <name> --path <path> --decision applied|rejected|deferred [--undo <trash path>]`; it appends one JSON line to `<GROK_HOME>/learn/decisions.jsonl`:

```json
{"date":"<YYYY-MM-DD>","run_dir":"<RUN>","id":"A3","kind":"skill","action":"delete","target":"<name>","path":"...","decision":"applied|rejected|deferred","undo":"<GROK_HOME>/learn/trash/<run name>/<name>"}
```

Set `<PYTHON> <skill dir>/state.py set --run-dir <RUN> --status curating` when group 1 opens and `--status done` when the last group closes or the user stops; `done` is what `--since-last` counts from. If the user re-invokes `/learn` while a run is pending, the resume path in step 0 handles it. After a completed run, the estimate's `since_last` scope is the recommended one, so a repeat run prices only the new sessions; if `since_last` has 0 sessions, say so and stop instead of relaunching over the same corpus.

Finish with what changed (paths), what was rejected or deferred, how to undo, and the full report path. In `step` and `auto` mode a run that changed nothing is unfinished unless the user rejected or deferred every action; say which.

## Rules

- Nothing is retired, edited, or trashed before `wait` has returned `report_ready` and the report is on screen — not even when the user asked up front to "delete the stale skills": that request is curated from the report, never executed from the collection. `state.py trash` before a report is a bug, whoever asked.
- Zero hits is evidence, not proof, and only in a wide window (`manifest.json` → `disuse_evidence.sufficient`). The only copy of a job is an `ask`, not a delete. A skill in slash MRU, or one that other loaded skills reference, is not a free delete.
- One repeated phrase is one action; it joins the skill that already owns the job when one exists.
- Never print secrets: tokens, headers, env values, API keys, auth files. Inventory is names and paths only.
- If the user disputes a count, re-run the collector; do not guess.
- Skill edits follow the bundled `skill-design-principles` skill.
