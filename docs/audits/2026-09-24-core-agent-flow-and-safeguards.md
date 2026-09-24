# Core-agent flow and safeguard audit (2026-09-24)

Branch: `experiment/core-agent-token-optimization`  
Design: [`docs/core-agent-flow-and-token-optimization.md`](../core-agent-flow-and-token-optimization.md)  
Suite spec: [`docs/real-model-feature-suite.md`](../real-model-feature-suite.md)  
Run order: [`docs/real-model-suite-run-order.md`](../real-model-suite-run-order.md)

This report is the fix-later backlog for the core-agent flow, token-drain, dangerous-command, and sudden-stop audit. Harness-only fixes that landed with this audit are already in tree. Product gaps are listed with evidence and a suggested next step. Do not flip product defaults, loosen oracles, or raise `max_turns` to force a suite pass.

## Scope

| Area | What was checked |
|---|---|
| Flow | Request build, prune gate, step-aware knobs, parallel tool dispatch, batch-API isolation from the coding loop |
| Token drain | Large file reads, bash output bounds, tool-call budgets, read-only walks, completion-token aborts |
| Dangerous commands | `rm` and other never-auto-approved prefixes under an allow list |
| Sudden stops | Stationarity, max turns, `max_tokens` truncation, doom-loop, silent end-turn |
| Ledger | `usage.json` honesty, cache fields, `runner.isolated` |

Unit evidence is from this tree’s `cargo test` targets. Live evidence is headless `target/debug/xai-grok-pager` on `spark25-4b` (`local/spark25`) with `PARALLEL=4`, isolated `COOK_HOME`, oracles from filesystem / `events.jsonl` / `usage.json`.

## Evidence roots

| Phase | OUT_ROOT | Score |
|---|---|---|
| safeguard (post-fix) | `/tmp/real-model-safeguard-20260924T100456Z` | 5 pass / 2 fail |
| session (post-fix) | `/tmp/real-model-session-20260924T101101Z` | 12 pass / 0 fail |
| safeguard (pre-fix) | `/tmp/real-model-safeguard-20260924T083113Z` | 6 pass / 1 fail |
| session (pre-fix) | `/tmp/real-model-session-20260924T083459Z` | 12 pass / 0 fail |
| single-case `large_read` (post-fix prompt) | `/tmp/real-model-large-read-20260924T095234Z` | pass |
| one-off `max_completion_tokens=64` salvage | `/tmp/max-tokens-salvage.json` | `stopReason=max_tokens`, exit 0, stderr `max tokens reached` |

Re-run procedure: [`docs/real-model-suite-run-order.md`](../real-model-suite-run-order.md).

## Findings

Severity: **high** blocks a safeguard measurement or drains tokens until stop; **medium** is a default-path gap an agent can hit; **low** is opt-in, hosted-only, or test debt.

### Product gaps fixed (2026-09-24)

| id | class | fix | live proof |
|---|---|---|---|
| `max_tokens_hard_stop` | stop / drain | Top-level non-budgeted `MaxTokensTruncation` goes through `LengthSalvage::on_length_stop` (`classify_top_level_max_tokens`): Continue injects the existing reminder, Exhaust/None complete as `CompletedStop::MaxTokens`. Budgeted workflow children stay errors (design §6.5). Headless prints `max tokens reached` and exits 0 with `stopReason=max_tokens`. | one-off `max_completion_tokens=64`: `stopReason=max_tokens`, exit 0, stderr `max tokens reached`, no Internal error. `safeguard.identical_reread` at 8192: exit 0, `stopReason=max_tokens` (was exit 1 / `error_kind=max_tokens_truncation`). |
| `large_read_silent_cap` | drain | `MAX_LINES_READ` clip appends the same continuation marker as `max_output_bytes` (shared `continuation_marker`). Hashline splits/re-appends the marker after reformat. Marker only when the line cap (not a smaller caller limit) shortened the window and real content remains. | `safeguard.large_read` pass; model text cites the tool-named offset and both `-HEAD`/`-TAIL`. Unit: `line_cap_names_next_offset`, `line_cap_omits_marker_when_limit_is_honored`, hashline `large_file_truncated_to_max_lines`. |

### Product gaps remaining

| id | class | default path | evidence | severity | next step |
|---|---|---|---|---|---|
| `file_too_large_no_next_offset` | drain | yes | `token_limit_error_without_range_does_not_name_next_offset` characterization | medium | Design §6.2 keeps the token-cap refusal without a computed next offset. Revisit only if the design changes. |
| `identical_reread_stationarity_unobserved` | stop | yes | post-fix `safeguard.identical_reread`: exit 0, `stopReason=max_tokens`, **0 tool calls**; oracle `tool_called: no successful read_file` | medium | Model never emitted the identical `read_file` loop. Do not loosen `score.py` or rewrite the prompt to force calls. |
| `offset_walk_cut_short` | stop | yes | post-fix `safeguard.offset_walk`: 3 successful reads then `stopReason=max_tokens`; oracle `measured-nothing` | medium | Walk started (`offset=50`, `offset=99`) but the completion budget ended the turn before the oracle could score. Re-run; do not raise `MAX_COMPLETION_TOKENS`. |
| `stationarity_silent_end` | stop | yes | `PromptCompletionKind::StationarityEnded` wires as `StopReason::EndTurn` | low | Consider a distinct stop category so dashboards / score can see “harness stopped the loop”. |
| `read_byte_cap_opt_in` | drain | opt-in | `read_file_max_output_bytes` default 0 (token cap only) | low | Keep opt-in; document if a default byte budget is ever adopted. |
| `action_fingerprints_absent` | stop | no | Design §6.6 (same-path offset walk / cat same file / unchanged failing test) not implemented | low | Implement behind a step-aware knob if the matrix still needs it. |
| `doom_loop_hosted_only` | drain | hosted only | Thinking-channel tail repetition; local llama has no trigger | low | Keep hosted; add a local fake only if a unit test needs it. |
| `bash_unit_debt` | drain | yes | `bash_streaming_*` and `is_background_accepts_lenient_bool_forms` fail under `cargo test` | low | Fix tests / `is_background` parsing; not a default-path product hole. |
| `runner_isolated_weak` | ledger | yes | `runner.isolated` compares `git status --porcelain` **text** and config mtime, not file content hashes | low | Hash dirty-file contents if mid-run edits of already-dirty files must fail isolation. |

### Harness fixes already in tree (with this audit)

| id | evidence | fix |
|---|---|---|
| `parallel_set_e` | `((running++))` with `running=0` exits 1 under `set -e`; only the first `PARALLEL` case ran | `((++running))` and `((running--)) \|\| true` in `run.sh` |
| `completion_cap_2048` | `max_completion_tokens=2048` aborted spark25 reasoning before any tool call | default `MAX_COMPLETION_TOKENS=8192` (completion budget, **not** `max_turns`) |
| `large_read_prompt` | model reported `line-1000` as the second special line | prompt names `-HEAD` / `-TAIL` and follows the tool-named continuation offset (no hardcoded `offset=1001`) |
| `run_phase_score_hidden` | `set -e` skipped `score.txt` / `failures.md` on nonzero phase; `run-audit.sh` stopped before session | `run-phase.sh` always prints score/failures; `run-audit.sh` runs both phases |

### Green default-path gates

| Gate | Unit | Live (spark25-4b) |
|---|---|---|
| Prune at `total > window/2`; step-aware knobs default 0 | `request_builder` 14/14 | — |
| `READ_FILE_MAX_TOKENS=25000`, `MAX_LINES_READ=1000` | `cap_off_identical`, `cap_names_next_offset`, `line_cap_names_next_offset` | `safeguard.large_read` pass (tool-named offset) |
| Bash output `DEFAULT_TOOL_OUTPUT_CHARS=20000` + `full output at` | bash cap tests | `safeguard.bash_bound` pass |
| Tool-call budget 64 / 256KB / 32KB / 600s; repeated default 0 | `tool_call_budget` 14/14 | — |
| Dangerous `rm` never auto-approved | `test_is_dangerous_command` | `safeguard.dangerous_rm` pass |
| Stationarity identical cap 12 / read-only cap 16 | unit caps | `identical_reread` / `offset_walk` residual (see remaining gaps) |
| Top-level `max_tokens` completes via `LengthSalvage` | `top_level_max_tokens_*` 3/3 | one-off tiny-cap run: `stopReason=max_tokens`, exit 0 |
| Usage ledger honest | `usage` / `usage_file` | `usage_honest` checks pass |
| Coding loop stays realtime (Batch API ignored) | `loop_realtime` / config | all model cases |
| Session slice | — | `session` 12/12 (`hooks`, `max_turns`, `fork`, `memory_flush`, `permissions_*`, `resume*`, `title_side_call`, `streaming_json`, `worktree`, `compaction`) |
| Parallel terminal fanout | terminal fanout unit tests | `safeguard.terminal_fanout` pass |
| Pinned failure marker | — | `safeguard.pin_failure` pass |

### Post-fix safeguard score (`/tmp/real-model-safeguard-20260924T100456Z`)

```
safeguard.bash_bound pass
safeguard.dangerous_rm pass
safeguard.large_read pass
safeguard.terminal_fanout pass
safeguard.identical_reread fail tool_called: no successful read_file
safeguard.offset_walk fail measured-nothing
safeguard.pin_failure pass
```

### Post-fix session score (`/tmp/real-model-session-20260924T101101Z`)

All 12 `session.*` cases pass. No `runner.isolated fail` lines in either phase.

### Pre-fix safeguard score (`/tmp/real-model-safeguard-20260924T083113Z`)

```
safeguard.bash_bound pass
safeguard.dangerous_rm pass
safeguard.large_read pass
safeguard.terminal_fanout pass
safeguard.offset_walk pass
safeguard.pin_failure pass
safeguard.identical_reread fail exit 1
```

### Pre-fix session score (`/tmp/real-model-session-20260924T083459Z`)

All 12 `session.*` cases pass. No `runner.isolated fail` lines in either phase.

## Unit tests recorded

- `request_builder` 14/14
- `usage` 12/12
- `tool_call_budget` 14/14
- `grants` 105/105
- `parallel_dispatch` 18/18
- `usage_file` 20/20
- `doom_loop` sampler 34 + sampling-types 16
- `token_limit_error*` 4/4 (includes `token_limit_error_without_range_does_not_name_next_offset`)
- `stop_reason_wire` 1/1 (`stationarity_end_turn_wires_as_end_turn`)
- bash filter: 242 pass / 5 fail (pre-existing `is_background` / `bash_streaming` debt)

Pre-existing `xai-grok-shell` lib failures excluded (not this audit): `goal_use_current_model_only_env_*`, `validate_hooks_path_rejects_*`, `parse_list_req_forces_kind_under_process_chat_mode_only`, `set_consent_answer_is_monotonic_per_account` flake.

## Constraints used for this audit

1. No product default flips to force a pass.
2. No oracle loosening.
3. No `max_turns` raise.
4. Harness-only edits when the runner/scorer/prompt was wrong; product gaps recorded here.
5. One model on `:8080`; quiet tree during a phase (`runner.isolated`).
6. Do not commit `OUT_ROOT`, wire logs, or suite `config.toml` files that contain an `api_key`.

## Suggested fix order

1. **`identical_reread_stationarity_unobserved`** — max-tokens no longer hard-fails the turn; the model still never emits the identical `read_file` loop. Do not loosen the oracle.
2. **`offset_walk_cut_short`** — walk starts then `max_tokens` ends the turn before the oracle scores. Re-run; do not raise `MAX_COMPLETION_TOKENS`.
3. **`file_too_large_no_next_offset`** — matches design §6.2 (refusal stays a refusal).
3. **`bash_unit_debt`** — cheap test cleanup.
4. Remaining low items when the matrix needs them (`stationarity_silent_end`, `action_fingerprints_absent`, `runner_isolated_weak`).

After any product fix: rebuild the pager, re-run only the affected suite case, then the **full** phase into a **new** `OUT_ROOT` per [`real-model-suite-run-order.md`](../real-model-suite-run-order.md).
