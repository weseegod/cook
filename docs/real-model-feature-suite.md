# Real-model feature suite

This is an implementer spec. It describes a headless test harness that drives the Cook binary against a real local model, scores the session artifacts, and leaves a failure report. It does not add the harness. Nothing under `scripts/` is part of this change.

The suite is the layer above `cargo test`: one debug binary, one real HTTP model, a throwaway git workdir, and pass/fail from the filesystem and the session record. It does not replace unit tests, and it does not drive the TUI or the desktop app.

Default model: launcher `mimo26-9b` from `/home/thanh/models/model.sh`, wire id `mimo26`, config key `local/mimo26`, port 8080. The same runner must accept `bonsai2-27b` (`bonsai2`, `local/bonsai2`) and `spark25-4b` (`spark25`, `local/spark25`) without a code change. One model at a time. They share the port.

Map of the product the cases line up against: `ARCHITECTURE.md`.

## 1. What the harness is for

A case fails when the agent did not do the thing, not when the model’s prose is clumsy. The oracle is the workdir, `events.jsonl`, and `usage.json`. The model’s own claim that it edited a file is not evidence.

When a case fails, the fix is a small change in the crate named by that case’s `pillar`. The runner does not edit Rust, does not take a `--fix` flag, and does not loosen an oracle to go green.

Do not, in order to make a case pass:

- flip a product default
- disable dream, memory capture, memory flush, the laziness classifier, prompt suggestion, or goal roles
- point the suite at `~/.local/bin/cook` (that binary is the pre-experiment install, not this tree)
- write the API key into git, into the redacted config, or into the failure report
- run two models on port 8080
- treat a partial or killed run as a score

## 2. Files to add

All of this is new. Do not fold it into `scripts/benchmark_step_pruning_live.sh`.

```
scripts/real-model-suite/run.sh
scripts/real-model-suite/README.md
scripts/real-model-suite/score.py
scripts/real-model-suite/lib/model.sh
scripts/real-model-suite/lib/home.sh
scripts/real-model-suite/lib/invoke.sh
scripts/real-model-suite/lib/fixture.py
scripts/real-model-suite/cases/<id>.json
scripts/real-model-suite/prompts/<id>.txt
```

`run.sh` is the only entry. Flags:

| Flag | Meaning |
|---|---|
| `--phase cli\|tools\|session\|agents\|all` | Default `all`. `cli` never starts the model. |
| `--case <id>` | One case. Still starts the model when that case has `"needs_model": true`. |
| `--list` | Print id, phase, needs_model. Do not start anything. |
| `--keep` | Do not delete `OUT_ROOT` on success. Failures are always kept. |

No `--fix`.

Environment, all optional:

| Variable | Default |
|---|---|
| `MODEL` | `mimo26-9b` |
| `WIRE` | `mimo26` (derived from `MODEL` when unset: strip the size suffix) |
| `MODEL_KEY` | `local/$WIRE` |
| `BASE_URL` | `http://127.0.0.1:8080/v1` |
| `COOK_BIN` | `<repo>/target/debug/xai-grok-pager` |
| `MODEL_SH` | `/home/thanh/models/model.sh` |
| `OUT_ROOT` | a new directory from `mktemp -d` |
| `CONTEXT_WINDOW` | `32768`, except the compaction case |
| `MAX_COMPLETION_TOKENS` | `2048`, with one retry at `8192` |

`README.md` in the suite directory is the short operator note: how to run a phase, how long `all` takes, and the “not covered” table from section 12. This document stays the spec. Do not copy the spec into the README.

## 3. Binary, home, model

Build once before a run, after any Rust edit:

```bash
cargo build -p xai-grok-pager-bin --bin xai-grok-pager
```

`cargo test` does not rebuild that binary. If `COOK_BIN` is missing, `run.sh` exits before starting a model.

Each case gets its own `COOK_HOME` under `OUT_ROOT/<phase>/<case>/home`. Never the user’s `~/.cook`. Resolution order in the product is `$COOK_HOME`, then `$GROK_HOME`, then `~/.cook`. An override equal to the real `~/.grok` or `~/.thanh` is ignored, so the temp home must be somewhere else.

Write `home/config.toml` with mode `0600`. Also write `home/config.redacted.toml` with the same text and the `api_key` line removed. The redacted file is the one a failure report may quote.

```toml
[ui]
permission_mode = "always-approve"

[model."local/mimo26"]
model = "mimo26"
model_provider = "local"
name = "real-suite mimo26"
input = ["text"]
context_window = 32768
max_completion_tokens = 2048
supports_reasoning_effort = false
supports_batch_api = true

[model_providers.local]
base_url = "http://127.0.0.1:8080/v1"
api_key = "<from key file, never printed>"
api_backend = "chat_completions"

[privacy]
privacy_banner_acked = "2026-01-01T00:00:00Z"

[consent.answers.aup]
version = 2
account = "suite@example.com"

[consent.answers.tos]
version = 2
```

`permission_mode` under `[ui]` accepts `ask`, `auto`, `always-approve`, and `default` (`crates/codegen/xai-grok-shell/src/util/config/permissions.rs`). That is not the same vocabulary as `--permission-mode`. The CLI flag accepts only `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, and `plan`. The flag form of always-approve is `--always-approve` (alias `--yolo`). Tool cases set the toml key and also pass `--always-approve`. Permission cases omit both and pass `--permission-mode dontAsk`.

`supports_reasoning_effort = false` because `model.sh` already sends `reasoning_effort: medium` in the llama.cpp chat template for `mimo26-9b`. Sending it again from Cook makes the request disagree with the server. `supports_batch_api = true` is set on purpose: the scorer then checks the main loop did not go to `/v1/batches`. A local llama.cpp server has no batch API the agent should use for the tool loop.

Key lookup, in order, without echoing the value: `$LLAMA_API_KEY`, then `~/.config/llama/api_key`, then `~/.cook/bonsai_api_key`. If none exist, exit before `model.sh start`.

`model.sh start <MODEL>` returns immediately (`nohup`) and stops whatever else is bound to port 8080. Say that on stderr before starting. Poll `GET $BASE_URL/models` with the bearer key, up to 180 times, 2 seconds apart. Ready means HTTP 200 and the JSON `data[].id` contains `WIRE`. A few `connection refused` replies during boot are normal. On any exit, including a signal, `trap` runs `model.sh stop <MODEL>`. Do not start a second model. The `cli` phase does not call `model.sh` at all.

Empty assistant text is a MiMo cap problem, not a product bug by itself. If the top-level JSON `text` is empty and `stopReason` is not a clean `end_turn` with a successful tool, rewrite that case’s home with `max_completion_tokens = 8192` and run the case once more. Record which cap passed in `status.txt`. Do not loop further. A second empty result is a fail.

## 4. How one model case is invoked

Workdir is a fresh git repo under `OUT_ROOT/<phase>/<case>/workdir`, not the Cook repo. `fixture.py` runs `git init`, a trivial commit, and plants files. The nonce is `MARKER-<case-id>-<8 hex chars>`, created at run time, written only into fixture files. Prompt templates may contain `{{MARKER_FILE}}`, `{{WORKDIR}}`, and other path placeholders. They must not contain the nonce text.

Command shape:

```bash
COOK_HOME="$home" \
GROK_LOG_FILE="$case_dir/wire.log" \
RUST_LOG="info,xai_grok_shell=debug,xai_grok_sampler=debug" \
"$COOK_BIN" \
  -p "$prompt" \
  -m "$MODEL_KEY" \
  --allow 'Read(*)' --allow 'Edit(*)' --allow 'Bash(*)' \
  --always-approve \
  --max-turns "$max_turns" \
  --output-format json \
  --cwd "$workdir"
```

Permission rules use the filter names `Read`, `Edit` / `Write`, and `Bash`, not the tool ids. `Bash(*)` is tool-wide. Pass them on the CLI. Do not put broad allows in a project config inside the fixture: untrusted project rules are dropped.

Do not pass `--debug-file`. The wire log is `GROK_LOG_FILE`. Sampler lines look like `url=http://127.0.0.1:8080/v1/chat/completions` with the URL unquoted.

Stdout of `--output-format json` is one pretty-printed object. Score the top-level `text` field only. Do not score tool-result text that happens to contain the nonce. Fields the reducer always emits: `text`, `stopReason`, `sessionId`, `requestId`. `thought` is present only when the thought buffer was non-empty. Usage is attached by `attach_result_usage` when the turn reported it; the durable copy is `usage.json`, and that is what the scorer reads. `num_turns` is not a guaranteed top-level field of this object. For the max-turns case, use `stopReason` plus the session record, not a guessed JSON key.

`stopReason` wire values include `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`.

Timeouts, enforced by the runner (kill the pager process group, then score whatever was written):

| Kind | Seconds |
|---|---|
| CLI command | 30 |
| Ordinary model case | 480 |
| Compaction, subagent, workflow live run, ACP | 900 |
| `ask_user_question` case | 180, and a timeout that kills a live process is a fail named `hung` |

After the process exits, copy the session directory into `case_dir/session/`. Locate it with the product’s own rule, not a glob of the whole home:

- sessions root: `$COOK_HOME/sessions`
- cwd component: `encode_cwd_dirname` in `crates/codegen/xai-grok-config/src/paths.rs` (URL-encoding, or `{slug}-{blake3_16}` when the encoded form exceeds 255 bytes)
- a resumable session directory contains `summary.json`

Copy `usage.json`, `events.jsonl`, `chat_history.jsonl`, `updates.jsonl`, and `summary.json` even if the copy of the whole directory fails. If `summary.json` is missing, the case fails `no-session` before any other check. Also keep `stdout.json`, `stderr.log`, `wire.log`, `prompt.txt`, the workdir, and `status.txt`.

`status.txt` is one line: `pass`, `fail <reason>`, `unsupported <reason>`, or `skip-nondeterministic <reason>`. `score.txt` at the run root is those lines prefixed by the case id. `failures.md` lists only `fail` and `hung`.

## 5. Case file

One JSON file per case. No logic in the JSON. `score.py` and `run.sh` interpret it.

```json
{
  "id": "tools.read_file",
  "phase": "tools",
  "pillar": "crates/codegen/xai-grok-tools/src/implementations/grok_build/read_file",
  "needs_model": true,
  "max_turns": 6,
  "timeout_secs": 480,
  "permission": "approve",
  "allow": ["Read(*)"],
  "deny": [],
  "extra_args": [],
  "prompt": "prompts/read_file.txt",
  "expect_tools": ["read_file"],
  "forbid_tools": [],
  "checks": ["tool_called", "text_contains_marker", "usage_honest", "loop_realtime"]
}
```

`permission` is `approve` or `dont_ask`. `approve` writes `[ui] permission_mode = "always-approve"` and passes `--always-approve`. `dont_ask` omits that key and passes `--permission-mode dontAsk`.

`extra_args` is a string array appended as-is (`--continue`, `--memory-flush`, `--output-format`, `--no-subagents`, `--tools`, …). The runner still supplies `-m`, `--cwd`, and `COOK_HOME`. A case that sets `--output-format` in `extra_args` replaces the default `json`.

`checks` is an ordered list of the names in section 6. Unknown names are a harness bug, not a product fail: the runner exits before the model starts.

## 6. Scoring

`score.py` is pure. It reads the case JSON and the case directory. It does not start a model and does not import the Cook tree. `--self-test` builds tiny fake artifacts in a temp dir and asserts the rules below, then exits. Run that before any GPU work.

### 6.1 `tool_called`

`events.jsonl` is one JSON object per line, tag `type`, snake_case (`crates/codegen/xai-grok-session-events/src/types.rs`). A completed call looks like:

```json
{"type":"tool_completed","tool_name":"read_file","duration_ms":12,"outcome":"success","tool_call_id":"…"}
```

`outcome` is `success`, `error`, `permission_rejected`, `permission_cancelled`, `followup`, `hook_denied`, `invalid_tool`, or `cancelled`.

Pass when every name in `expect_tools` has at least one `tool_completed` with `outcome` `success`. Names are the tool ids the model sees, not the registry key `GrokBuild:read_file`. The shell tool is `run_terminal_cmd`, not `bash`.

`events.jsonl` does not store arguments. Argument checks read `chat_history.jsonl` first. If that file has no tool-call arguments, fall back to `wire.log` and look at the assembled `tool_calls` on the chat-completions request, not at a single SSE delta. On the first real `read_file` run, print one captured arguments object into the suite README’s “artifact shape” note and lock the parser to it. Do not guess a second shape.

Fail the case when any completed call’s arguments are `{}` or empty while `wire.log` contains the literal `<tool_call>`. That is the MiMo regression: llama.cpp streams an XML envelope inside `function.arguments`, often with a newline after `<tool_call>` and a newline before `</function>`. The Standard chat-completions adapter (local provider, not `provider_id == "xiaomi"`) must recover those envelopes. Recovery already lives next to the Xiaomi parser in `xai-grok-sampler`. This check is the lock. A run that used clean JSON and never emitted `<tool_call>` still passes.

Required argument keys, when that tool completed:

| Tool id | Key that must be present and non-empty |
|---|---|
| `read_file` | `target_file` |
| `grep` | `pattern` |
| `list_dir` | `target_directory` |
| `search_replace` | `file_path` |
| `run_terminal_cmd` | `command` |
| `web_fetch` | `url` |

If the captured schema uses a different key, fix the table after one real run. Do not accept an empty path.

### 6.2 `tool_not_called`

No `tool_started` or `tool_completed` whose `tool_name` is in `forbid_tools`.

### 6.3 File checks

`file_contains`, `file_equals`, `file_unchanged` compare the workdir after the process exits with the fixture snapshot taken before launch. `file_unchanged` is the whole tree except `.git`. A marker check reads the nonce from the fixture file, never from the prompt.

### 6.4 `text_contains_marker` and `text_nonempty`

`text_contains_marker` looks at top-level `text`. For `agents.workflow_live` it also accepts the nonce in any session workflow `state.json` `result_summary`, matching that case’s “parent `text` or the workflow result” rule. `text_nonempty` requires non-empty `text` and `stopReason` of `end_turn`, unless the case JSON sets `"allow_stop": ["max_turn_requests"]`.

### 6.5 `usage_honest`

Read `usage.json`. The session object is the file itself when `purposeUsage` is top-level, otherwise `session`. Confirm which on the first run; both shapes have existed in tests (`UsageSummary` versus `SessionUsageFile`).

Rules, matching `crates/codegen/xai-chat-state/src/usage.rs`:

- `cacheFieldPresent == false` means `uncachedInputTokens` is absent. It must not be `0`. `true` means the key is present and the number is ≥ 0. Apply the same pair of rules to each purpose row.
- A purpose row with `modelCalls == 0` is legal when `usageMissingCalls > 0`. Those calls reported no usage. Do not invent tokens for them, and do not fail the row for being zero. Fail a row only when `modelCalls`, `inputTokens`, `outputTokens`, and `usageMissingCalls` are all zero.
- No double count: the sum of `modelCalls` across purpose rows equals the session `modelCalls`, and the same for `inputTokens`. Include a missing-usage row as zero calls, which is what it stores.
- Side purposes (`session_title`, `memory_capture`, `memory_dream`, `memory_flush`, `laziness`, `prompt_suggestion`, `goal_evaluator`, compaction, `subagent`, …) may be present. Their presence is not a failure. A side row that aborts the main task (empty `text` plus `stopReason` `cancelled` with no successful expected tool) is a failure named `side-call-aborted`.

Purpose keys: `main_loop`, `compact_single`, `compact_pass1`, `compact_pass2`, `subagent`, `recap`, `turn_summary`, `title_refresh`, `btw`, `memory_capture`, `memory_dream`, `memory_flush`, `laziness`, `goal_evaluator`, `prompt_suggestion`, `image_describe`, `session_title`.

### 6.6 `loop_realtime`

`wire.log` contains `/v1/chat/completions` or `/v1/responses`, and does not contain `/v1/batches`.

### 6.7 `denied`

For each name in `expect_tools`, a `tool_completed` has `outcome` `permission_rejected` or `hook_denied`, or a `permission_resolved` has `decision` `deny`. The file check paired with this case must be `file_unchanged`. A successful write is a fail even if some other call was denied.

### 6.8 `resumed` and `forked`

`resumed`: the second process’s `sessionId` equals the first, and `text` contains the nonce the first process wrote. `forked`: the second `sessionId` differs, and `text` still contains the nonce. Both processes use the same workdir and the same `COOK_HOME`.

### 6.9 `isolated`

After the case, `git status --porcelain` in the Cook repo is empty apart from the harness files this work is adding, and the user’s `~/.cook` has the same mtime on `config.toml` as before the run. The runner records that mtime at start. A change fails the run, not just the case.

### 6.10 Self-test fixtures

1. `cacheFieldPresent: false` together with `uncachedInputTokens: 0` → fail `usage_honest`.
2. `cacheFieldPresent: false` and the key absent, purpose sums matching → pass `usage_honest`.
3. A purpose row of all zeros → fail. A row with `modelCalls: 0` and `usageMissingCalls: 1` → pass.
4. `events.jsonl` with `tool_completed` / `read_file` / `success`, plus a wire log containing `<tool_call>` and arguments `{}` → fail `tool_called`.
5. The same events with arguments `{"target_file":"secret.txt"}` and no `<tool_call>` → pass.

## 7. Phase `cli`

No model process. These commands must exit 0 under the isolated home. Stderr may contain a remote-registry warning. Do not treat that warning as a failure. Do not follow a login prompt. A command still running at 30 seconds is `hung`.

`cook sessions` is not a local-only listing. `sessions list` calls the remote session registry best-effort and does not force an interactive login (`sessions_cmd.rs`). Assert the local session shows up. Ignore a remote error line.

`cook memory` has one subcommand, `clear`. There is no `memory list`. Do not invent one.

`cook export` and `cook usage` need a session id. They are not part of the no-model phase. They run as `cli.export` and `cli.usage` only after `sampler.noop` in an `all` run, against that case’s home and id.

| Id | Argv, after the binary | Pass |
|---|---|---|
| `cli.version` | `--version`, then `version --json` | First stdout non-empty. Second parses as JSON with a version field. |
| `cli.models` | `models` | Stdout contains the `MODEL_KEY` string. The server may be down. |
| `cli.inspect` | `inspect --json` | Exit 0, JSON mentions the isolated home’s `config.toml`. |
| `cli.doctor` | `doctor` | Exit 0. If it blocks on a TTY or fails only because clipboard or color is missing, record `unsupported` with the stderr line. Do not hang. |
| `cli.completions` | `completions bash` | Stdout non-empty and is not a clap error. |
| `cli.sessions_empty` | `sessions list` | Exit 0 on a home with no sessions. |
| `cli.sessions_after` | `sessions list`, same home as `sampler.noop` | Stdout contains that `sessionId`. Remote warning allowed. |
| `cli.usage` | `usage <sessionId>` | Stdout contains `purposeUsage`. |
| `cli.export` | `export <sessionId>` | Stdout is markdown and does not contain the API key. It does not have to contain the nonce. |
| `cli.memory_help` | `memory --help` | Stdout contains `clear` and does not offer a list subcommand. Do not run `memory clear`. |
| `cli.mcp_list` | `mcp list --json` | Exit 0, JSON is an empty list or an object with no servers. |
| `cli.plugin_list` | `plugin list --json` | Exit 0. Do not pass `--available` (that talks to a marketplace). |
| `cli.leader_list` | `leader list` | Exit 0. Do not run `leader kill`. |
| `cli.du` | `du` | Exit 0. |
| `cli.worktree_list` | `worktree list` with `--cwd` the fixture repo | Exit 0. |

Do not run `login`, `logout`, `update`, `setup`, `share`, or `trace`. They hit an x.ai account or the release network.

## 8. Phase `tools`

Default tool ids the model actually sees (`Tool::id` in `xai-grok-tools`). Registry keys are `GrokBuild:<id>` and are not what the scorer looks up.

| Id | Role |
|---|---|
| `read_file`, `search_replace`, `list_dir`, `grep` | Files |
| `run_terminal_cmd` | Shell. Not `bash`. |
| `todo_write`, `update_goal` | Session plan state |
| `enter_plan_mode`, `exit_plan_mode` | Plan mode |
| `ask_user_question` | Questions |
| `task`, `send_subagent_message`, `get_task_output` | Subagents |
| `wait_tasks`, `kill_task` | Background tasks |
| `get_terminal_command_output`, `kill_terminal_command` | Background shell |
| `monitor` | Short or persistent watch |
| `scheduler_create`, `scheduler_list`, `scheduler_delete` | Recurring tasks |
| `workflow` | Rhai workflows |
| `web_search`, `web_fetch` | Network |
| `lsp` | Language server |
| `memory_search`, `memory_get` | Memory tools |
| `search_tool`, `use_tool` | MCP |
| `send_feedback` | Local feedback draft |
| `image_gen`, `image_edit`, `image_to_video`, `reference_to_video` | Not in this suite |

Prompts below are the template text. Paths in `{{…}}` are filled by the runner. The nonce is never in the prompt.

### `sampler.noop`

Prompt: “Reply with the single word pong. Do not call any tool.”

`forbid_tools` is every tool. Checks: `text_nonempty`, `tool_not_called`, `usage_honest`, `loop_realtime`, `isolated`. `max_turns` 2.

### `sampler.xml_arguments` and `tools.read_file`

Fixture: `secret.txt` holds the nonce. `other.txt` holds a different nonce.

Prompt: “Read {{MARKER_FILE}} and reply with the exact line it contains. Do not read any other file.”

`expect_tools`: `["read_file"]`. Checks: `tool_called`, `text_contains_marker`, `usage_honest`, `loop_realtime`.

`tools.read_file` adds a negative: `text` must not contain the other file’s nonce.

`sampler.xml_arguments` is the same prompt plus the XML argument rule in section 6.1. It fails if that recovery is removed. It passes if the model emitted clean JSON and the file was actually read.

### `tools.read_file_range`

`secret.txt` is 40 lines. The nonce is on line 20 only. Prompt tells the model to read that line range and reply with it. `text` contains the nonce. Do not require the whole file in `text`.

### `tools.list_dir`

Plant `alpha.txt`, `beta.txt`, `gamma.txt`. Prompt: list `{{WORKDIR}}` with the directory tool and reply with the three names. `expect_tools`: `list_dir`. `text` contains all three names. Fail if `text` contains a fourth planted name that was not created (`delta.txt`).

### `tools.grep`

Nonce is only inside `nested/note.txt`. Prompt: search the workdir for the line that starts with `MARKER-` using the search tool, not by opening every file, and reply with that line. `expect_tools`: `grep`. `text` contains the nonce. A `read_file` of `nested/note.txt` as well is allowed. A run that never calls `grep` fails even if `text` is right.

### `tools.bash`

`secret.txt` holds the nonce. Prompt: read that file and, using the terminal tool, write that exact line to `out.txt`. Do not use a file-edit tool.

`expect_tools`: `run_terminal_cmd`. `forbid_tools`: `search_replace`. `out.txt` equals the nonce plus a newline. The command string in the captured arguments must not be empty.

### `tools.search_replace`

`note.txt` contains the line `REPLACE_ME` and two other lines. Prompt: replace the line `REPLACE_ME` with `DONE-EDIT` using the edit tool, and do not change the other lines.

`expect_tools`: `search_replace`. The file equals the oracle. `forbid_tools`: `run_terminal_cmd`.

### `tools.write_new`

Prompt: read `secret.txt` and create `notes.txt` whose only line is that file’s contents. Either `search_replace` or `run_terminal_cmd` may succeed. At least one of them must be `tool_completed` / `success`, and `notes.txt` must match. This is the one write case that does not pin the tool.

### `tools.todo_write`

Prompt: record two todos, “alpha” and “beta”, and mark alpha completed, using the todo tool. Reply with both words.

`expect_tools`: `todo_write`. The todo payload in `chat_history.jsonl` or `updates.jsonl` contains both words and a completed alpha. There is no separate on-disk oracle. If neither log contains the payload, fail `no-todo-record` rather than grepping the whole home.

### `tools.update_goal`

Prompt: set the session goal to the exact line in `secret.txt`. `expect_tools`: `update_goal`. The tool result or the following assistant text contains the nonce. Do not guess a goal file path. If a goal file appears under the session directory, it must also contain the nonce.

### `tools.parallel_reads`

Three files, three nonces. Prompt says the model may read them together and must reply with all three lines. Pass when `text` has all three. Do not require a single turn with three parallel calls. Fail if any nonce is missing.

### `tools.serial_edit_read`

Prompt: replace `REPLACE_ME` with `DONE-EDIT` in `note.txt`, then read the file back and reply with the new line. `expect_tools`: `search_replace` and `read_file`, and the `read_file` `tool_completed` must come after the `search_replace` one in `events.jsonl`. File matches the oracle. `text` contains `DONE-EDIT`.

### `tools.kill_and_wait`

Prompt: start a background terminal command that sleeps 2 seconds and then writes the line from `secret.txt` into `out.txt`. Then wait for it with `wait_tasks` or read it with `get_terminal_command_output`. Do not use a persistent monitor.

`expect_tools` includes `run_terminal_cmd` and one of `wait_tasks` or `get_terminal_command_output`. `out.txt` matches. The pager process must exit. `max_turns` 8. Pass `--background-wait-timeout 60` via `extra_args` so a finished background command is not held for the default 600 seconds. Do not pass `--no-wait-for-background` here; that flag is for scripts that ignore background work.

### `tools.monitor_short`

Prompt: use `monitor` on a command that prints the line from `secret.txt` and exits. `persistent` must be false. The process exits, `text` or the tool result contains the nonce, and no `monitor` task is still running at exit (`stderr` must not end in a wait for a persistent monitor).

### `tools.scheduler_roundtrip`

Prompt: create a scheduled task with interval `60s` whose prompt is the line in `secret.txt`, list schedules, then delete that task. Do not set `durable` true.

`expect_tools`: `scheduler_create`, `scheduler_list`, `scheduler_delete`. After exit, the isolated home has no scheduled-task record containing the nonce. List output during the session did contain an id. Do not write into the user’s scheduler store; the isolated `COOK_HOME` is what makes that true. Assert `isolated` as well.

### `tools.memory_roundtrip`

Prompt: remember the line in `secret.txt` as a durable memory, then search memory and reply with that line.

`expect_tools`: `memory_search` or `memory_get` (at least one) after a write the memory tool or a memory file performed. The nonce appears in a file under `$COOK_HOME/memory` and in `text`. Do not call `cook memory clear`.

### `tools.web_fetch_public`

The runner starts `python3 -m http.server` on `127.0.0.1` and a free port, serving one file whose body is the nonce. It stops the server when the case ends. Prompt: fetch that exact URL with `web_fetch` and reply with the body. No internet URL.

`expect_tools`: `web_fetch`. `text` contains the nonce.

### `tools.web_fetch_ssrf`

Prompt: try `web_fetch` on `file:///etc/passwd` and on `http://169.254.169.254/`. Reply with whether each was refused. Do not use the terminal.

Pass when `text` does not contain a line that looks like a passwd entry (`root:x:0:0:`) and does not contain cloud metadata markers (`ami-id`). A `tool_completed` of `error` for `web_fetch` is a pass. A success whose result body is empty or is a refusal is a pass. A success that echoes `/etc/passwd` is a fail. This case does not need the nonce.

### `tools.lsp_smoke`

Fixture contains `lib.rs` with `fn main() {}`. Prompt: ask the `lsp` tool for diagnostics on that file. If no server is configured, say so in one sentence.

Pass when the process exits 0 and either `lsp` completed or `text` says no language server is available. Do not require a real diagnostic. Crash or `hung` fails.

### `tools.plan_mode`

Prompt: enter plan mode, write the plan text “plan-ok” into the plan, and exit plan mode. Do not edit files in the workdir.

`expect_tools`: `enter_plan_mode` and `exit_plan_mode`. `file_unchanged` on the workdir. Headless has no plan-approval UI. If `exit_plan_mode` blocks on approval, that is a fail named `plan-blocked`, not a reason to add a new flag. `max_turns` 6, timeout 180.

### `tools.ask_user_headless`

Prompt: you must call `ask_user_question` with one question whose option labels are “red” and “blue”, then stop.

This case characterizes headless behavior. Pass when the process exits before 180 seconds. Record the `tool_completed` outcome in `status.txt`. Do not pass `--no-ask-user` on this case or on any other case. A hang is `hung`. After two identical runs, freeze the expected outcome in the case JSON. Until then, do not fail on `error` versus `success`.

### `tools.unknown_and_sibling`

Prompt: read `secret.txt` with `read_file` and reply with its line.

The model will usually not emit a bogus tool. If no `tool_completed` has `outcome` `invalid_tool`, write `skip-nondeterministic` and do not count it as a product failure. If an invalid tool does appear, `read_file` must still have completed with `success` and `text` must contain the nonce. Do not prompt the model with a fake tool name; that tests instruction following, not the adapter.

### `tools.feedback_noop`

Prompt: call `send_feedback` with the title “suite” and a one-line body, then reply “sent”. `expect_tools`: `send_feedback`. The user’s session feedback drafts must be unchanged (`isolated`). A local draft under the isolated home is allowed. Any HTTP call in `wire.log` that is not the local llama server fails the case.

### Not a model case: mixed file toolsets

The registry rejects a config that enables both `read_file`/`search_replace`/`grep` and `hashline_read`/`hashline_edit`/`hashline_grep` (`validate_config` in `xai-grok-tools`). That is already a unit test. Do not add a model case for it unless a headless flag surfaces the error. The hashline smoke in phase `agents` uses only the hashline ids.

## 9. Phase `session`

Same home and workdir across the processes of one case. Side purposes stay enabled.

### `session.resume`

Process 1 prompt: read `secret.txt` and reply with its line. Process 2, same cwd, same home, `extra_args` `["-c"]`, prompt: “What exact line did you read from secret.txt? Do not read the file again.”

Checks: `resumed`, and process 2 `text` contains the nonce. If process 2 calls `read_file` anyway, still pass `resumed` when the session id matches and the nonce is present. The point is that resume works, not that the model obeys “don’t read”.

### `session.resume_by_id`

Same as resume, but process 2 uses `-r <sessionId>` from process 1’s JSON instead of `-c`.

### `session.fork`

Process 2 adds `--fork-session` to the resume-by-id invocation. Checks: `forked`. The workdir file hash is unchanged from process 1.

### `session.permissions_read_only`

`permission`: `dont_ask`. `allow`: `["Read(*)"]`. No `Edit`, no `Bash`, no `--always-approve`. Prompt: replace `REPLACE_ME` in `note.txt` with `DONE-EDIT`. Checks: `file_unchanged`, `denied` if a write tool was attempted. A model that only refuses in prose, with no write tool call and an unchanged file, passes. A successful `search_replace` fails.

### `session.permissions_deny_bash`

`permission`: `dont_ask`. `allow`: `["Read(*)"]`. `deny`: `["Bash(*)"]`. Prompt: run a terminal command that writes `secret.txt`’s line to `pwned.txt`. `pwned.txt` must not exist. A `run_terminal_cmd` completion must not be `success`.

### `session.compaction`

This case is invalid unless compaction actually ran. Do not guess the window.

Start from the corpus shape that already tripped the pruning arm in `scripts/benchmark_step_pruning_live.sh`: 12 files, about 8000 bytes each, a unique nonce line in file 01 and another in the last file. Set only this case’s `context_window` low enough that the last main-loop call exceeds 80% of the window (auto-compaction). The runner reads `usage.json` after the attempt.

Prompt: read every planted file and reply with the nonce line from the last file.

Pass when `purposeUsage` contains `compact_single` or both `compact_pass1` and `compact_pass2`, and `text` contains the last nonce. If no compaction purpose is present, status is `fail measured-nothing`. Shrink the window or grow the files and rerun. Do not raise the window to avoid compaction, and do not mark the case passed. Write the window and file size that worked into the case JSON once, as comments are not allowed in JSON, so use fields `context_window` and `fixture.file_bytes`.

### `session.memory_flush`

Process 1 is a normal read of `secret.txt`. Process 2 is the same home and `--resume <id>` with `--memory-flush` and no new prompt (`-p` omitted). The CLI documents `--memory-flush` as headless-only; do not try to pass the slash command as `-p` text.

Pass when `purposeUsage` contains `memory_flush`, some file under `$COOK_HOME/memory` contains the nonce, and process 1’s `summary.json` still exists.

### `session.hooks`

Write the hook into `$COOK_HOME/hooks/log-read.json`, not into the fixture’s `.grok/hooks/`. Project hooks need a trust step. Home hooks are the global source (`grok_home.join("hooks")` in `xai-grok-config`).

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          { "type": "command", "command": "bin/log-read.sh", "timeout": 5 }
        ]
      }
    ]
  }
}
```

`bin/log-read.sh` appends one line to `$COOK_HOME/hook-log.txt` and exits 0. It prints nothing to stdout, so it does not change what the model sees. Matcher `Read` also matches `read_file`.

Prompt is the read-file prompt. Pass when `hook-log.txt` has exactly one line. Zero lines is a fail `hook-not-fired` (check the discovery log before moving the file). More than one line is a fail `hook-repeated`.

### `session.worktree`

`extra_args`: `["--worktree", "suite-wt"]`. Prompt: write `DONE-EDIT` into `note.txt` by replacing `REPLACE_ME`. The fixture repo’s `note.txt` is unchanged. The worktree’s `note.txt` has `DONE-EDIT`. The runner removes the worktree afterward with `worktree rm` against the isolated home, not against the user’s worktrees. `--cwd` is the fixture, so the worktree must not show up under the Cook repo.

### `session.title_side_call`

Same as `sampler.noop`. Do not require `session_title`. If that row exists, it must satisfy `usage_honest` (not an all-zero row). `text` is still non-empty.

### `session.max_turns`

`max_turns` 1. Prompt: read `secret.txt`, then edit `note.txt`. Those are two model turns if the first turn is only the read. Pass when the process exits, `stopReason` is `max_turn_requests` or stderr contains `max turns` (any case), and the run did not continue into a second edit after the cap. `text` may be empty. Do not retry this case at cap 8192; an empty text here is the cap on turns, not on completion tokens.

### `session.streaming_json`

`extra_args`: `["--output-format", "streaming-json"]`. Prompt is the read-file prompt. Every stdout line parses as JSON. The final result line’s text contains the nonce. A non-JSON line fails.

## 10. Phase `agents`

### `agents.subagent_read`

Prompt: use the `task` tool to spawn one subagent whose only job is to read `{{MARKER_FILE}}` and return the line. Reply with that line.

`expect_tools`: `task`. `text` contains the nonce. Either `purposeUsage.subagent` is present or a second session directory exists under the same `COOK_HOME`. The Cook repo has no new worktree (`isolated`). `timeout_secs` 900. `--background-wait-timeout 120`.

### `agents.no_subagents_flag`

The same prompt with `extra_args` `["--no-subagents"]`. No second session directory. The parent may read the file itself. `text` contains the nonce. A `task` tool `success` fails the case.

### `agents.workflow_validate`

Do not run deep-research. Prompt the model to call `workflow` with `validate_only: true` and an inline `source` of type `script`. The script is planted in `script.rhai` and is small enough to paste. It must start with a literal `let meta = #{ name: "...", description: "..." };`. The body should not call `agent()`.

`expect_tools`: `workflow`. The tool outcome is `success`. No child session is created. If the tool rejects inline scripts, status is `unsupported inline-workflow` only after the error text says so. Do not add a product API to make this pass.

### `agents.workflow_live`

Only if `agents.workflow_validate` passed. A script with one `agent()` that reads `secret.txt`. `agent_budget` 2. Pass when the parent `text` or the workflow result contains the nonce and the child count stayed inside the budget. Timeout 900. If validate passed but live runs are rejected for external scripts, `unsupported`, with the tool error quoted in `failures.md` only when it is a real `fail`.

### `agents.mcp_echo`

The runner writes a tiny stdio MCP server (Python, one tool `echo` that returns its `text` argument) and registers it with the isolated home:

```bash
COOK_HOME="$home" "$COOK_BIN" mcp add echo -- python3 "$server"
```

Confirm the server landed in the isolated `config.toml` and not in `~/.cook`. Prompt: use `search_tool` to find `echo`, then `use_tool` to echo the line from `secret.txt`, and reply with that line.

`expect_tools`: `use_tool`. `text` contains the nonce. The server process is gone after the pager exits. Do not leave it running.

### `agents.acp_stdio`

Do not invent JSON-RPC method names. Take the handshake from the existing client path:

- method name constants and the `session/new` line shape in `crates/codegen/xai-acp-lib`
- `initialize` and `new_session` on `MvpAgent` in `crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs`

Drive `COOK_HOME=… "$COOK_BIN" agent stdio` with the model flag and the fixture cwd. Sequence: `initialize`, `session/new`, one prompt that reads `secret.txt`, then read replies until the turn stop. Stdout lines are JSON-RPC. The turn result contains the nonce. Timeout 900. If the handshake in tree uses a different method than `session/new`, follow the tree and record the method in the suite README. A hand-written method that is not in the tree is a harness bug.

### `agents.codex_apply_patch`

`extra_args` includes the `--tools` value that selects the Codex toolset and not the default file tools. Confirm the flag’s syntax with `--help` before freezing it; the flag is `--tools` (comma-separated built-in tools). The prompt asks for `apply_patch` to change `REPLACE_ME` to `DONE-EDIT`. File matches. `expect_tools`: `apply_patch`. If `--tools` cannot select that tool, `unsupported` with the help text. Do not add a new flag.

### `agents.hashline_edit`

Same pattern for `hashline_edit` only. Do not also enable `read_file` / `search_replace` / `grep` in that session. The mixed set is rejected by the registry and would fail for a different reason.

### `agents.opencode_read`

`--tools` selects the OpenCode read tool (`read`, not `read_file`). Prompt is the read-file prompt. `text` contains the nonce. One smoke case, not a port of every OpenCode tool.

### Leader

Do not attach to a leader and do not spawn one for a shared session. `cli.leader_list` is the only leader case. A second client on the user’s leader socket would collide with a running TUI.

## 11. Fixture rules

`fixture.py` takes the case id and the workdir. It is deterministic given the nonce, which the runner passes in. It always:

- `git init` and one commit so worktree and hooks have a root
- writes `secret.txt` for cases that need a hidden nonce
- writes a `MANIFEST.json` next to the workdir (outside it) listing relative paths and sha256 values taken before the agent runs

The snapshot is how `file_unchanged` is computed. Do not snapshot after the agent starts.

The local HTTP server for `web_fetch` binds `127.0.0.1` only and serves one directory. It is not started for any other case.

## 12. Covered and not covered

“Every feature” here means every feature the headless agent executes. The table is the answer for the rest. The suite README must include this table so a later reader does not think the gaps were forgotten.

| Surface | In this suite | Why |
|---|---|---|
| Headless one-shot (`-p`) | Yes | The runner. |
| Agent turn loop, sampler, tools, workspace FS, permissions, sessions, memory, compaction, hooks, worktree | Yes | Phases `tools` and `session`. |
| Subagents, workflow, MCP, ACP stdio, Codex / hashline / OpenCode smoke | Yes | Phase `agents`. |
| CLI that stays on the machine | Yes | Phase `cli`. |
| TUI slash commands, key bindings, scrollback, theme, voice, mermaid | No | Headless never enters `pager/src/app/event_loop.rs`. Owner: `xai-grok-pager-pty-harness` and pager unit tests. |
| Desktop `frontend/apps/let-cook` | No | Separate ACP client. It does not reimplement tools. |
| `image_gen`, `image_edit`, `image_to_video`, `reference_to_video` | No | Imagine API, not llama.cpp. A later `CLOUD=1` opt-in can add one case. Default off. |
| `login`, `logout`, `update`, `setup`, `share`, `trace` upload, telemetry | No | Account and release network. |
| Sandbox kernel (Landlock / seccomp) | Opt-in only | Add `session.sandbox_blocks_escape` only if `--sandbox` on this Linux host blocks a read of a file outside the workdir. If it does not block, `unsupported`, not a pass. |
| Leaf crates (render, fuzzy search, sqlite journal, crash handler, and the rest of the 93) | No | No model behavior. `cargo test -p <crate>`. |
| Full parity of concise, Codex, OpenCode, and hashline toolsets | No | Three smokes. The registry tests own the rest. |
| Shared leader session | No | Collides with an interactive user. |

## 13. Failure report and the fix loop

`failures.md` is generated. One section per failing case:

- id and `pillar` path
- expected check and the one-line reason from `status.txt`
- paths to `stdout.json`, `events.jsonl`, `usage.json`, `wire.log`
- if the reason is the XML argument rule, up to 40 lines of `wire.log` around the first `<tool_call>`, with the API key redacted
- no suggested patch

Fix order once the harness itself is in place:

1. Land the harness in one commit. No product change in that commit. `score.py --self-test` passes. `run.sh --phase cli` passes without a llama process.
2. Start `mimo26-9b`. Run `--phase tools`. Fix the first failure in its `pillar` only. Add a unit test when the bug is a parser (the XML argument case is the example). Do not widen the oracle.
3. Re-run `--case <id>`, then the whole phase.
4. Repeat until `tools` is green, then `session`, then `agents`.
5. One product bug per commit, subject line short, so the bugfix can be cherry-picked without the harness. The harness commit stays separate. That split matches `UPSTREAM-MERGE.md`: a third-party-model bugfix is in scope; the suite is fork test infrastructure and must not be required to compile the fix.
6. Do not commit `OUT_ROOT`, wire logs, or any config that still has `api_key`.

`unsupported` and `skip-nondeterministic` are listed at the bottom of `failures.md` under those headings and do not fail the exit code. `fail` and `hung` do. Exit 0 only when no case is `fail` or `hung`.

Wall clock on MiMo, one model, no parallelism: `tools` about 30–50 minutes, `session` about 20 minutes, `agents` about 20–40 minutes. `all` is one GPU hold. `model.sh status` must not show `mimo26-9b` after the script exits, including after a kill, because of the trap.

## 14. What not to re-decide while implementing

- Answer text is the top-level JSON `text`, not a tool result.
- Unreported cache is omitted, never stored as 0.
- A purpose row with `usageMissingCalls > 0` and `modelCalls == 0` is honest.
- Shell tool id is `run_terminal_cmd`. Permission filter name is `Bash`.
- `[ui] permission_mode = "always-approve"` is not the same string set as `--permission-mode`.
- `cook memory` only has `clear`.
- Hooks for the suite live in `$COOK_HOME/hooks`, not in the fixture’s `.grok/hooks`.
- Session directories are `$COOK_HOME/sessions/<encode_cwd_dirname(cwd)>/<sessionId>/` and need `summary.json`.
- Empty completions retry once at 8192 tokens, except `session.max_turns`.
- The five known `xai-grok-shell` lib failures (`goal_use_current_model_only_env_true`, `goal_use_current_model_only_env_overrides_config_false`, `validate_hooks_path_rejects_outside_grok_home`, `validate_hooks_path_rejects_traversal_attack`, `parse_list_req_forces_kind_under_process_chat_mode_only`) are pre-existing. A new failing test name is in scope. The consent monotonicity test flakes under parallel `cargo test` and is not a suite regression when it fails only in the full parallel run.

## 15. Implementation status and handoff (2026-09-22)

Current phase: **`tools`**. The harness is implemented; the full tools phase still needs to be run to completion.

Completed:

- [x] Added the runner, pure scorer, model/home/invocation/fixture helpers, and ACP driver under `scripts/real-model-suite/`.
- [x] Added all 60 case definitions and 45 prompt templates for the `cli`, `tools`, `session`, and `agents` phases.
- [x] Added isolated `COOK_HOME` and fixture repositories, model lifecycle cleanup, timeout handling, one-time completion-cap retry, artifact collection, `score.txt`, and `failures.md`.
- [x] Added scorer self-tests and documented the observed `chat_history.jsonl` tool-call argument shape and stock-profile tool aliases.
- [x] Ran the standalone `cli` phase. Twelve independent CLI cases passed. `cli.export`, `cli.sessions_after`, and `cli.usage` were correctly marked `unsupported dependency sampler.noop not run`; run them through `--phase all` after a model session exists.
- [x] Added a sampler regression fix and unit test for a complete JSON argument object followed by appended XML tool envelopes. The focused sampler tests pass and the debug pager binary builds.
- [x] Started real-model validation of the tools phase and confirmed `sampler.noop` and `tools.ask_user_headless` pass.

Remaining for the next implementer:

- [ ] Run the complete tools phase. The last run was intentionally interrupted at `tools.feedback_noop`; it is not a valid full-phase score.
- [ ] Stabilize `sampler.xml_arguments`: it passed one earlier attempt but failed the last attempt with `no successful read_file`.
- [ ] Fix or classify `tools.bash`: one attempt timed out and the last attempt exited with status 1.
- [ ] Run and fix the unscored tools cases from `tools.feedback_noop` onward. An earlier partial attempt reached `tools.feedback_noop` and reported no successful `send_feedback`.
- [ ] Once tools is green, run and fix `session`, then `agents`.
- [ ] Run `--phase all` so the three session-dependent CLI cases are scored with a model-created session.
- [ ] Run the broader crate tests before declaring the suite complete. A separate `xai-grok-agent` library run had one new failure, `prompt::template::tests::test_encrypted_templates_not_stale`, which still needs triage.

Resume with:

```bash
cargo build -p xai-grok-pager-bin --bin xai-grok-pager
python3 scripts/real-model-suite/score.py --self-test
scripts/real-model-suite/run.sh --phase tools --keep
```

The most recent interrupted artifacts are under `/tmp/cook-real-tools-final.aIMFdy` on the machine that produced this handoff. Do not treat that directory's `score.txt` as a complete phase result and do not commit it.
