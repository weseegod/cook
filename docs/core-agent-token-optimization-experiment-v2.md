# Core agent token optimization, experiment v2

Date: **2026-09-22**.

Companion design: [core-agent-flow-and-token-optimization.md](core-agent-flow-and-token-optimization.md). Source-checked comparison with Pi, and the list of what this plan does not copy: [core-agent-vs-pi-coding-agent.md](core-agent-vs-pi-coding-agent.md). Pi is pinned there at `1a584a7a56eb5e7b4ff8ccbd46430f1533282eed`.

What v1 already shipped and measured: [core-agent-token-optimization-experiment.md](core-agent-token-optimization-experiment.md).

This document is the implementation plan. It does not change Rust, defaults, or the tool API. No phase below has been executed on `mimo26-9b` or `spark25-4b`. The bonsai omission fixture from v1 (3/3, 8,840 → 230 prompt tokens) is not a result for the other two models.

Task correctness is the gate. A shorter prompt that misses the failure, the permission, or the edit is a failed phase. Token and price come after that.

One phase, one matrix, one commit. Do not start the next phase in the same commit. Commit only when every quality cell of that phase’s matrix passes on all three local models. A cache column that the server does not report is a recorded gap, not a quality failure. A model that fails to load is a failed phase, not a skipped column.

## 1. What stays as it is

- The `model → tools → model` loop.
- Defaults. The step-aware arm stays opt-in at zero. `two_pass_compaction` and `compaction_verbatim_input` stay at their current registry defaults until a later phase’s matrix says a change does not drop task success.
- Per-model context window. Do not retune it from this plan. The live harness may still *set* a window so that an arm under test actually engages; that is a harness parameter, recorded per run, not a new product default.
- Provider Batch API off the coding loop. Section 9 of the design document is the rule. Whether a model may use Batch API at all is the user’s `[model.*]` row in `~/.cook/config.toml`, same kind of switch as `supports_reasoning_effort`. Cook does not ship a hardcoded list of which ids have a discount.

## 2. Local setup

Three models, one GPU, one port. They cannot run together. Weights on this machine:

| Launcher name | File under `~/.local/share/llama-models/` | Wire id the server advertises | Configured context in `~/models/config.json` |
|---|---|---|---|
| `bonsai2-27b` | `Ternary-Bonsai-2-27B-PQ2_0.gguf` | `bonsai2` (`--alias`) | 131072, parallel 1. Needs the PrismML `llama-server` named in `~/models/model.sh` |
| `mimo26-9b` | `MiMo-V2.6-Distill-Qwen-9B-Q8_0.gguf` | `mimo26` (`--alias`) | 65536, parallel 1. Needs the PrismML `llama-server` named in `~/models/model.sh` |
| `spark25-4b` | `Spark-X2.5-4B-Q4_K_M.gguf` | `spark25` (`--alias`) | 327680, parallel 4 |

Launcher: `~/models/model.sh`. It stops whatever is already on port 8080 before starting. API key: `LLAMA_API_KEY`, else `~/.config/llama/api_key`. The existing endpoint harness reads `BONSAI_API_KEY`, else `~/.cook/bonsai_api_key`. Point them at the same key and do not print it:

```bash
export BONSAI_API_KEY="$(tr -d '[:space:]' < "$HOME/.config/llama/api_key")"
~/models/model.sh start bonsai2-27b
# Wait until the next command prints a model id. Loading a 27B file can take a few minutes.
curl --fail --silent -H "Authorization: Bearer ${BONSAI_API_KEY}" \
  http://127.0.0.1:8080/v1/models | jq -r '.data[].id'
```

Stop that model before starting the next one. `~/models/model.sh stop <name>` is enough; `stop` with no name stops every model the launcher tracks.

Reasoning. The v1 bonsai run spent the whole completion cap in the reasoning channel until the request set `reasoning_effort=none` and the matching `chat_template_kwargs`. `scripts/benchmark_step_pruning.sh` already sends that. `mimo26-9b` boots with medium reasoning (`--chat-template-kwargs` in the launcher), so an empty `content` with a full completion count means the cap was eaten. Retry that cell once at `MAX_TOKENS=800` with the same reasoning override, and record which cap produced the answer. Do not treat an empty content field as a wrong verdict.

Known harness limit. `scripts/benchmark_step_pruning.sh` honors `BONSAI_MODEL`, so phase 1 can target all three wire ids. `scripts/benchmark_step_pruning_live.sh` writes `model = "spark25"` into the generated Cook config even when `MODEL_KEY` changes. Live-loop cells for bonsai and mimo26 are not runnable through that script until that wire name is taken from the environment. Until then, those two models use the endpoint matrix only, and the live script is the spark25-4b column of any cell marked “live”.

Cook binary for live cells: `cargo build -p xai-grok-pager-bin --bin xai-grok-pager`. The installed `~/.local/bin/cook` at the v1 base revision does not contain this branch.

## 3. How a matrix is scored

Every phase matrix has the same shape: three model rows, the cells listed for that phase, one run each unless the cell says otherwise. Temperature 0. Record prompt tokens, cached tokens, completion tokens, latency, and the quality verdict. Cached tokens come from `usage.prompt_tokens_details.cached_tokens` when the server sends it. If the field is absent, write `unreported`. Do not invent a zero.

Quality pass for the omission fixture, unchanged from v1:

- The answer contains one JSON object.
- `verdict` is `PASS`.
- `test` is `response_without_usage_preserves_context_and_marks_ledgers_incomplete`.
- The patch fact (`mark_usage_incomplete_nowait`) is still visible to the model in the prompt that was sent. The optimized arm replaces rounds 1–6 only.

A prose answer that happens to say PASS is a fail for that cell (`no-json`). An empty answer after the 800-token retry is a fail (`empty`).

Cost is not a pass/fail in any phase until the quality cells have passed. When it is reported, split it:

```text
uncached = prompt_tokens - cached_tokens    # only when cached_tokens is a number
```

On the v1 live harness, billed input includes cache reads. Mean uncached rose from about 35,000 to about 72,000 while total prompt tokens fell. That split is why a raw-token drop is not a saving on DeepSeek or MiMo, where a hit is about 1–2% of a miss. llama.cpp numbers are not those invoices.

## 4. Phase 1 — baseline matrix, no product change

Purpose: learn whether the omission fixture and the prefix cache behave on all three local models before any new policy is written. No Cook code in this phase.

Run, per model, after the setup in section 2. Fidelity, one process, both arms:

```bash
BONSAI_BASE_URL=http://127.0.0.1:8080/v1 \
BONSAI_MODEL=<wire id> \
RUNS=1 \
REASONING_EFFORT=none \
MAX_TOKENS=160 \
scripts/benchmark_step_pruning.sh
```

Cache, same server, after fidelity. The body is a repeated padding line of a few thousand characters plus `Reply with exactly the single word PING.` Send it twice with temperature 0 and `max_tokens` 16. The second response is `cache_warm`. Send a third request whose first line differs and whose padding is byte-identical. That response is `cache_bust`.

| Cell | bonsai2-27b | mimo26-9b | spark25-4b | Pass |
|---|---|---|---|---|
| `fidelity_baseline` | endpoint script, arm `baseline` | same | same | JSON `PASS` and the test name |
| `fidelity_omitted` | endpoint script, arm `optimized` | same | same | Same bar. Rounds 1–6 are the omission marker |
| `cache_warm` | second identical request | same | same | Record `cached_tokens`. `unreported` is allowed |
| `cache_bust` | first line changed | same | same | Record `cached_tokens`. If both warm and bust are numbers, bust must be lower than warm. If either is `unreported`, record the gap and do not fail the phase on it |

Phase 1 passes only when all six fidelity cells pass. Then commit the result table into this file. Do not commit a table that copies the v1 bonsai numbers onto mimo26 or spark.

### Phase 1 results (2026-09-22)

Run one process at a time on `:8080`, temperature 0, `REASONING_EFFORT=none`, `MAX_TOKENS=160` (no 800-token retry was needed). Quality bar: one JSON object, `verdict` `PASS`, `test` = `response_without_usage_preserves_context_and_marks_ledgers_incomplete`. Both arms keep rounds 7–8, so `mark_usage_incomplete_nowait` stays in the prompt.

| Cell | bonsai2-27b | mimo26-9b | spark25-4b | Pass |
|---|---|---|---|---|
| `fidelity_baseline` | 8,840 prompt / 78 completion / 11 s | 8,837 / 39 / 4 s | 9,946 / 57 / 2 s | yes ×3 |
| `fidelity_omitted` | 230 / 78 / 2 s | 227 / 39 / 1 s | 256 / 62 / 1 s | yes ×3 |
| `cache_warm` | cached 624 of 628 | 621 of 625 | 633 of 634 | recorded |
| `cache_bust` | cached 0 of 628 | 0 of 625 | 0 of 634 | bust &lt; warm ×3 |

Notes:

- All six fidelity cells returned JSON `PASS` with the required test name. Answers are not copied across models; each column is a separate request.
- Prefix cache reports `cached_tokens` on the second identical body (`cache_warm`) and `0` when the first line changes (`cache_bust`). No `unreported` gap on this server for the cache cells.
- Fidelity `cached_tokens` were `0` on the first baseline requests (and `9` on spark’s omitted arm); those zeros are reported zeros, not missing fields.
- Prompt drop baseline → omitted: bonsai 8,840 → 230 (97.4%), mimo26 8,837 → 227 (97.4%), spark 9,946 → 256 (97.4%). The v1 bonsai drop is reproduced and extended to the other two local models on this fixture only.

Raw log: `~/.grok/long-running-background-tasks/cook-token-v2-phase1-20260922-120311/`.

Rollback: nothing was changed. Stop the model.

## 5. Phase 2 — pin evidence before omitting more

The current step-aware arm keeps the newest tool round and whatever still fits the round and character budget. That is recency, not importance. v1 section 18 kept both markers on one read-file task and did not show that a failure buried in an older round survives.

Implementation, default still off:

- Carry provenance from tool execution into the request-copy pruner: exit status, whether the result is a failed check, whether a process is still live, and whether the result is the edit the assistant has not finished with. Do not classify this by scanning free-form log text.
- The active round stays raw, as it does now, even when one parallel batch exceeds the character budget.
- A pinned result stays raw even when it is outside the round window. If the pin plus the active round exceed the character budget, keep the pins and the active round, and say so in the placeholder for what was dropped. Do not drop a pin to honor the budget.
- Files: `crates/codegen/xai-chat-state/src/actor/request_builder.rs`, the pruning config in `crates/codegen/xai-chat-state/src/types.rs`, and the tool result that already knows exit status. No change to canonical history. No new public tool name. An omission stays out of canonical history. This phase does not add an audit entry for it.

Matrix. Quality cells only. The token columns are recorded and do not decide the commit.

| Cell | What it protects | How | Pass |
|---|---|---|---|
| `pin_old_failure` | A failing check that is not in the newest rounds | Endpoint fixture: rounds 1–6 are success noise except round 2, which is the only failure; rounds 7–8 are unrelated success. Omission policy on | All three models name round 2’s test and do not call the run clean |
| `active_round` | Evidence the model has not consumed | Existing request-builder tests, plus one endpoint prompt per model whose only real patch is in the last round | Active patch present in the answer; call id still paired in the Rust test |
| `live_markers` | The v1 live task still holds | `scripts/benchmark_step_pruning_live.sh` at `CONTEXT_WINDOW=40000`, `RUNS=1`, spark25-4b only until the live script’s wire name is configurable. Bonsai and mimo26 run `pin_old_failure` and `active_round` only | Both markers present, and the debug log shows the arm fired. A run with zero prune events is not a pass and not a fail of the policy; widen nothing, fix the window, rerun |
| `stale_read` | A file changed after it was read | One spark live turn: read a file, overwrite it, ask for the new line | The answer quotes the new line, not the pre-change line |

Phase 2 fails if any quality cell fails on any model that ran it. Leave the settings at zero in the default config. Commit the pin behavior and this matrix, not a default flip.

### Phase 2 results (2026-09-22)

What shipped:

- `ToolResultProvenance { failed, still_live, unresolved_edit }` on `ToolResultItem`, `#[serde(skip)]`, so canonical history, the wire request, and persisted snapshots are unchanged. It is rebuilt at the push site from the typed `ToolOutput` (exit status, error flag, a still-running task, a successful edit), never by scanning rendered text.
- `PruningConfig::pin_evidence`, default `false`. `spawn` sets it from the step-aware knobs, so with the knobs at their defaults the arm does not run and the pin cannot touch a default session. A pinned result is kept raw outside the round window and is not charged against `recent_tool_result_char_budget`; when pins are present, what is dropped says so (`…recent step budget spent on newer pinned evidence`).
- `PruningReport::pinned_kept` is reported on the same `tracing` line the live harness greps.

Endpoint matrix, one process per model, temperature 0, `MAX_TOKENS=160`:

| Cell | bonsai2-27b | mimo26-9b | spark25-4b | Pass |
|---|---|---|---|---|
| `pin_old_failure` | 1,183 prompt / 60 completion / 3 s | 1,180 / 35 / 2 s | 1,323 / 46 / 1 s | yes ×3 — all named round 2's failed test, none named the newest round's |
| `active_round` | 1,165 / 86 / 3 s | 1,162 / 58 / 1 s | 1,302 / 76 / 1 s | yes ×3 — all carried `mark_usage_incomplete_nowait` |

Rust cells (no model): `pinned_failure_outside_the_round_window_stays_raw`, `pin_is_off_unless_the_step_arm_enables_it`, `pin_is_not_charged_against_the_character_budget`, `live_process_and_unverified_edit_results_are_pinned_too`, `unpinned_omissions_keep_the_original_placeholder`, plus the pre-existing `active_round` pairing tests. `xai-chat-state --lib` 389 passed / 0 failed; `xai-grok-shell --lib` 7007 passed with only the six known pre-existing failures (`goal_use_current_model_only_env_{true,false}`, `validate_hooks_path_rejects_{outside_grok_home,traversal_attack}`, `parse_list_req_forces_kind_under_process_chat_mode_only`, and the flaky `set_consent_answer_is_monotonic_per_account`).

Live cells, spark25-4b only (the live script still hardcodes the `spark25` wire name), `CONTEXT_WINDOW=40000`, `RUNS=1`, arm on in its home:

| Cell | Result | Pass |
|---|---|---|
| `live_markers` | baseline both-markers at 15 calls; stepaware both-markers at 13 calls, `prune_events=5`, rounds cleared 30, chars reclaimed 237,720 | yes — both markers and the arm fired |
| `stale_read` | read, overwrite, ask: answer quoted `VALUE-NEW-2`, not `VALUE-OLD-1` | yes |

Notes:

- The step-aware live arm again shows the split the design calls out: main-loop prompt input fell 317,205 → 262,887 while `tool_result_tokens` fell 94,081 → 60,165, and compaction calls stayed at 5 in both arms. This is not presented as a saving (see the uncached split in section 3).
- `still_live` and `unresolved_edit` are carried and pinned, but no live cell exercised them: `live_markers` and `stale_read` use only the failure pin and the active round. Those two flags rest on the unit tests above.
- Raw logs: `~/.grok/long-running-background-tasks/cook-token-v2-phase2-20260922-121345/` (endpoint) and `…-phase2-live-20260922-121706/` (live).

## 6. Phase 3 — append-only tool output

Shorten output when the tool produces it. Do not rewrite an earlier byte on the next sample. The sliding request-copy arm stays available and opt-in for comparison. It is not the design this phase turns on.

Implementation, flag default off:

- Bash already caps model-visible output and keeps a full log path. Leave that shape: tail plus path. Do not copy another harness’s 50KB or 2,000-line numbers.
- Read file can still return on the order of 25,000 estimated tokens. The 1,000-line cap already keeps the head and names the next offset, the total line count, and the range shown (`read_file/mod.rs`). An opt-in generation cap, if this phase adds one, reuses that continuation marker. It does not add a head-and-tail truncation for reads. The middle is recovered by reading the named offset, not by a second truncation style. Do not lower `READ_FILE_MAX_TOKENS`.
- The active tool result is never capped below the evidence the model has not yet seen. Cap the *next* generation. Request-time pruning still must not eat the active round. v1 already states that.
- Files: `crates/codegen/xai-grok-tools/src/implementations/grok_build/read_file/mod.rs`, the bash truncate helper only if the existing cap cannot point at the full log, and a Cook config flag next to the existing pruning settings. Default off, so a session that does not set the flag is byte-identical to today.

Matrix:

| Cell | Models | Pass |
|---|---|---|
| `cap_off_identical` | Rust test, no model | Flag absent or zero. Read output matches the current helper |
| `cap_names_next_offset` | Rust test, no model | Over-cap read keeps the first line, names the next offset, the total line count, and the shown range. Call id unchanged. It does not need a tail or a saved-file path |
| `bash_keeps_tail_and_path` | Rust test, no model, only if this phase edits the bash helper | Over-cap bash output keeps the tail and a path to the full log. Skip the cell when bash is untouched |
| `middle_error_recoverable` | All three, endpoint | A file whose only error line sits past the notice’s shown range. The model-visible body may omit it. The answer must still report that error after the prompt tells the model to read the named offset. Guessing “no error” is a fail |
| `prefix_stable` | All three, endpoint | Two identical follow-up requests after a capped tool result. `cache_warm` cached tokens, when reported, are greater than zero. A third request that rewrites an earlier result (the phase 2 sliding behavior, simulated in the prompt) is `cache_bust` and must show fewer cached tokens when both numbers exist |
| `live_spark_append` | spark25-4b only, live script, flag on in that home only | Both markers. Prune-event count may be zero, because this phase should not need a mid-history rewrite. Fidelity still required |

Do not lower `READ_FILE_MAX_TOKENS` globally in this phase.

### Phase 3 results (2026-09-22)

What shipped:

- `PruningConfig::read_file_max_output_bytes`, default `0`, and `PruningSettings::read_file_max_output_bytes: Option<usize>`. The key sits in `[compaction.pruning]` beside the pruning settings, because both decide how much tool output reaches the model, and it does not rewrite anything after the fact.
- `AgentRebuildSpec::read_file_max_output_bytes` → `AgentBuilder::with_read_file_max_output_bytes`, which seeds `Params<ReadFileParams>` after finalize (updating in place when a value is already installed, so `cursor_rules_on_read` is not clobbered). `0` and an absent key install nothing, so the session is byte-identical to today.
- `read_file/mod.rs` keeps its existing `apply_byte_budget` path and its existing continuation marker (next offset, total line count, shown range). `READ_FILE_MAX_TOKENS` is still 25,000 and `MAX_LINES_READ` is still 1,000. Bash is untouched, so `bash_keeps_tail_and_path` is skipped.

Rust cells (no model):

| Cell | Result | Pass |
|---|---|---|
| `cap_off_identical` | With no `Params<ReadFileParams>` the budget accessor returns `None`, so the budget branch cannot be entered. A 200-line file read with the flag unset is byte-identical to the same read with a budget that cannot bind (both sides captured to `{SCRATCH}/cap-off.txt`, sha256 `c081ec55…`): 200/200 lines, no marker of any style | yes |
| `cap_names_next_offset` | Budget 500 on the same fixture keeps the first whole lines, one marker naming `rerun with offset=<kept+1>`, `file has 200 total lines`, `showing lines 1-<kept>`, one truncation style only, same tool-call id, `READ_FILE_MAX_TOKENS` unchanged | yes |
| `bash_keeps_tail_and_path` | — | skipped (bash untouched) |
| `read_file_cap_resolves_from_pruning_table_and_defaults_off` | The key resolves from `[compaction.pruning]` (2500), defaults to 0 when absent or zero, and a key outside the table does not resolve | yes |

Endpoint matrix, one process per model, temperature 0, `MAX_TOKENS=160` (800 retry on an empty answer):

| Cell | bonsai2-27b | mimo26-9b | spark25-4b | Pass |
|---|---|---|---|---|
| `middle_error_recoverable` | 935 prompt / 5 completion / 1 s | 932 / 5 / 1 s | 946 / 6 / 0 s | yes ×3 — all named `retry_drops_payload`, the annotated line at 36 of 41, which exists only past the `showing lines 1-32` cut |
| `prefix_stable` | warm-first 0, warm 1,266, bust 0 cached | 0 / 1,263 / 0 | 0 / 1,274 / 0 | yes ×3 — warm cached tokens > 0 and bust < warm on every model; every cache column was reported by the server, so no `unreported` cell |

Live cell, spark25-4b only (the live script still hardcodes the `spark25` wire name), `CONTEXT_WINDOW=40000`, `RUNS=1`, `PRUNING_EXTRA="read_file_max_output_bytes=2500"` in the step-aware home only:

| Cell | Result | Pass |
|---|---|---|
| `live_spark_append` | Flagged arm (`read_cap_bytes=2500`): both markers in the answer at 3 turns / 16 s, `prune_events=0`, `tool_result_tokens=7,226`. Unflagged arm for contrast: both-markers-lost at 24 turns / 190 s with 3 compaction calls | yes — fidelity holds with the cap on and the prune arm idle |

Notes:

- The cap shortened what each read returned and the flagged arm finished in three turns while the unflagged arm ran to the 24-turn cap and lost both markers. That is a fidelity observation, not a cost claim (the uncached split is section 3).
- Fixture wording for `middle_error_recoverable` was revised after two recorded attempts, with the raw answers kept. The first wording asked a yes/no question; spark25-4b answered “no defect” with the annotated line past the cut *and* with the whole file in one round (diagnostic variants A and E), so it measured phrasing rather than recoverability. The second wording asked for the annotated line and mimo26-9b answered the line number `41`. The committed fixture asks for the function name on the line the file annotates, with that line placed mid-continuation (36 of 41) so it cannot be produced by naming the first or last function in the block, and with a control arm that drops the annotation.
- Control arm, not a gating cell: with the annotation removed, bonsai2-27b and spark25-4b answered the explicit negative; mimo26-9b still named the function. Its pass meets the cell's literal bar (the answer names the function the file annotates) but is weaker evidence of keying on the annotation.
- The endpoint fixture carries the continuation read as the second tool round at the marker's named offset, because an endpoint cell cannot run tools. The rule it tests is unchanged: the error past the shown range must be reported and a “no error” guess fails.
- Raw logs: `~/.grok/long-running-background-tasks/cook-token-v2-phase3-final/` (endpoint matrix), `…-phase3-diag-20260922-124822/` and `…-phase3-diag2-20260922-124843/` (fixture diagnostics), `…-phase3-live-readcap-2/` (live).

## 7. Phase 4 — hit and miss in the session report

The ledger already stores cache reads, and `usage.json` already has `purposeUsage` and `requestComponents`. This phase only makes the uncached remainder explicit and refuses to treat “unreported” as zero.

Implementation:

- Where the provider usage includes cache reads inside input, the persisted report gains `uncachedInputTokens = input - cacheRead` for that call, plus a boolean `cacheFieldPresent`.
- Where the server omits the field, `cacheFieldPresent` is false and `uncachedInputTokens` is absent. Do not store 0. A latest-turn cache-hit footer is not part of this phase. The report stays the uncached remainder, and that remainder is absent when the server did not report the field.
- No change to what is sent to the model.
- Files: `crates/codegen/xai-chat-state/src/usage.rs`, `crates/codegen/xai-grok-shell/src/session/usage_file.rs`, and the existing usage-file tests.

Matrix, one short headless turn per model (`-p 'reply with exactly "ready"'`, `--output-format json`), then `usage <sessionId>`:

| Cell | Pass |
|---|---|
| `report_shape` | `purposeUsage` and `requestComponents` present on the session row. This is the v1 section 17 invariant, repeated per model |
| `cache_field_honest` | If the server sent cached tokens, the report shows them and the uncached remainder, and the remainder is not negative. If it did not, `cacheFieldPresent` is false and there is no zero standing in for the miss |
| `no_double_count` | One model call in the prompt does not appear as two purposes |

### Phase 4 results (2026-09-22)

What shipped:

- `TokenUsage::cached_prompt_tokens_present`: true when the provider response carried a cache-read number (Chat Completions `prompt_tokens_details`, Responses `input_tokens_details`, Messages `message_start.usage`), even if it was 0. A missing field is unknown, never zero.
- `UsageTotals` gains `uncached_input_tokens` (sum of `prompt - cached` over calls that reported the field), `cache_field_present_calls`, `cache_field_absent_calls`.
- The persisted report (`usage.json`, `UsageSummary` and `PurposeUsage` rows, flattened into turn rows) gains `uncachedInputTokens` and `cacheFieldPresent`. The remainder is present only when every call in the row reported the field; otherwise both the remainder and any zero are absent. An empty row is neutral, so summing a turn into the session cannot veto a reported field. The headless result JSON projects the same two fields.
- No change to what is sent to the model.

Rust cells (no model):

| Cell | Result | Pass |
|---|---|---|
| wire presence | `From<Usage>`: reported field (400 and 0) → present; absent field → not present, cached 0 | yes |
| ledger honesty | reported call → remainder `input − cached`; an unreported call adds nothing; no call reported → remainder absent | yes |
| report shape | `usage_file` tests: session, turn and purpose rows carry both fields; JSON keys `uncachedInputTokens`/`cacheFieldPresent`; a missing field serializes no remainder key | yes |

Matrix, one model (bonsai2-27b per the run's instruction), one headless turn `-p 'reply with exactly "ready"' --output-format json`, then `usage <sessionId>`:

| Cell | Result | Pass |
|---|---|---|
| `report_shape` | `purposeUsage` (keys `main_loop`) and `requestComponents` (`requestsMeasured=1`, 12,613 estimated tokens) on the session row | yes |
| `cache_field_honest` | The server reported the field with `cached_tokens=0` (cold cache): `cacheFieldPresent=true`, `cachedReadTokens=0`, `uncachedInputTokens=13,347 = inputTokens − 0`, not negative. The absent-field branch is covered by the Rust cells (no remainder key, no zero) | yes |
| `no_double_count` | Purpose rows sum to `modelCalls=1`, equal to the session's `modelCalls=1`; purpose remainders sum to the session remainder | yes |

Notes:

- The first end-to-end run exposed a real bug the unit tests had not: summing the turn row into the empty default session row let the empty row veto `cacheFieldPresent`. Fixed by making empty rows neutral; `usage.json` from the fixed binary shows the honest values above.
- Raw logs: `~/.grok/long-running-background-tasks/cook-token-v2-phase4-final3/` (cold-cache run), `…-phase4-warm/` (warm run), `…-phase4-final/` (the pre-fix run kept as the bug's evidence).

## 8. Phase 5 — `supports_batch_api` on the model row

No batch client on the coding loop. No waiting for DeepSeek off-peak. No `previous_response_id` work. No table inside the binary that marks MiMo on and DeepSeek or Grok off. Prices change, and the user already picks the model in `~/.cook/config.toml`.

Add one optional bool on `[model."<id>"]`, next to `supports_reasoning_effort`. Same file, same resolution path (`ModelInfo` / `Config::new_from_toml_cfg`). Name: `supports_batch_api`.

```toml
[model."mimo-v2.6-pro"]
model = "mimo-v2.6-pro"
model_provider = "xiaomi"
context_window = 1000000
supports_reasoning_effort = true
supports_batch_api = true

[model."deepseek/deepseek-flash"]
model = "deepseek-flash"
model_provider = "deepseek"
context_window = 1000000
supports_reasoning_effort = true
supports_batch_api = false

[model."local/spark25"]
model = "spark25"
model_provider = "local"
context_window = 32768
supports_reasoning_effort = false
# omitted supports_batch_api means false
```

| Value | Meaning |
|---|---|
| omitted | `false`. This model never uses Batch API |
| `false` | Same, and an explicit false wins over any later default. Do not auto-default this to true for any `api_backend`. Messages auto-defaults `supports_reasoning_effort`; it must not auto-default `supports_batch_api` |
| `true` | The user says this model accepts Batch API and they want the discount on calls that are allowed to wait |

`true` does not send the coding loop to `/v1/batches`. The interactive session does not branch on the flag. The only caller that may read it is an eval harness whose prompt is a frozen snapshot and whose next line does not edit a live tree. That call still has to meet the four conditions in section 9 of the design document: the user turned the flag on, the call does not gate the next tool step, the prompt is the realtime prompt, and nobody is waiting on a stream or a permission prompt. A flag left on for a local llama.cpp model does not create a batch endpoint. The harness checks the flag, then the server either accepts the job or the call fails visibly. It does not fall through into a silent realtime rewrite of the prompt.

Parse and store the field where `supports_reasoning_effort` is parsed and stored. Document it beside that field in `docs/byok-models.md`. Do not put a discount percent in the toml. The percent is the provider’s bill, not something Cook should recompute from a stale table.

Matrix:

| Cell | Pass |
|---|---|
| Rust: omitted | A `[model.*]` block with no `supports_batch_api` resolves false, including a MiMo id and a DeepSeek id |
| Rust: explicit | `supports_batch_api = false` resolves false. `= true` resolves true. The model id string is not consulted |
| Rust: no backend default | `api_backend = "messages"` without the key still resolves false |
| `loop_stays_realtime`, all three local models | Home config sets `supports_batch_api = true` on that local model. One headless turn. The sampler log shows `/v1/chat/completions` or `/v1/responses`, and does not show `/v1/batches`. The answer is still the one the prompt asked for |
| Prompt identity | The eval path, in a unit test, reads the flag from the resolved model. With the flag true it is given the same messages the realtime path would send. The test fails if the batch body drops tools or the evidence lines. With the flag false the eval path does not build a batch body |

Do not run a hosted batch in this phase. The local matrix cannot see a discount, and it should not pretend to. Turning the flag on for `bonsai2`, `mimo26-9b`, or `spark25` is only the negative test above.

### Phase 5 results (2026-09-22)

What shipped:

- `supports_batch_api` on `[model."<id>"]` in `config.toml`, parsed and stored exactly where `supports_reasoning_effort` is: `ModelEntryConfig` (serde default false), the TOML override (`Option<bool>`), merged into `ModelInfo`. Documented beside `supports_reasoning_effort` in `docs/byok-models.md`.
- No backend auto-defaults it. The `api_backend = "messages"` auto-default exists only for `supports_reasoning_effort` and was deliberately not replicated.
- The interactive loop does not read the flag. The only reader is the gate helper `sampling::eval_batch::eval_batch_request`, a future eval harness's entry point: the gate is closed unless the resolved model has the flag and none of the design-doc section 9 conditions fail (no gating tool step, nobody waiting on a stream, no permission prompt open). The body is built from the same conversation items the realtime path would send, via the shipped `conversation_to_chat_messages` mapping, with the same tools. There is no batch client anywhere in the tree (`grep v1/batches|batch_api|BatchApi` matched nothing before this phase; the flag is plumbed, not an endpoint).

Rust cells (no model), all through `Config::new_from_toml_cfg` + `resolve_model_list`:

| Cell | Result | Pass |
|---|---|---|
| omitted | `[model."mimo-v2.6-pro"]` and `[model."deepseek/deepseek-flash"]` without the key both resolve false (the id string is not consulted) | yes |
| explicit | `= false` resolves false, `= true` resolves true, both on a resolved model | yes |
| no backend default | `api_backend = "messages"` without the key still resolves false | yes |
| prompt identity | flag read from the resolved model; flag true → batch body messages equal `conversation_to_chat_messages` of the realtime items, evidence lines and both tool definitions survive; flag false → no batch body; any section-9 condition set → no batch body | yes |

Matrix, one model (bonsai2-27b per the run's instruction), one headless turn `-p 'reply with exactly "ready"' --output-format json` with home config setting `supports_batch_api = true` on `local/bonsai2`, sampler wire log captured via `RUST_LOG=xai_grok_sampler=debug`:

| Cell | Result | Pass |
|---|---|---|
| `loop_stays_realtime` | Wire log shows the sampler request `url=http://127.0.0.1:8080/v1/chat/completions` and contains no `/v1/batches` | yes |
| task still correct | Answer contains `ready` | yes |

Notes:

- Raw logs: `~/.grok/long-running-background-tasks/cook-token-v2-phase5-20260922-143511/` (`run.log`, `wire.log`, home `config.toml`, `out.json`).

## 9. Phase 6 — independent reads in one realtime response

This is the batch that can reduce token count: several reads that do not depend on each other, issued in one model response, executed together. It is not Batch API. Section 3.5 of the design document already has the runner (`FuturesUnordered`). This phase does not add a new executor.

What it must not do: run an edit and the test that reads that edit in one parallel step, in an order that tests the old bytes. A path lock is not a full analysis of a shell command. If the dependency is not obvious from the arguments, run the calls in the order the model emitted them.

No prompt change in the default template until the matrix passes. The matrix itself may use a task prompt that *allows* parallel reads. That prompt is part of the harness, not a new default system prompt.

| Cell | Models | Pass |
|---|---|---|
| `three_markers` | All three, endpoint or live where the wire name works | Three files, three distinct markers. The answer contains all three. One round or three rounds are both passes |
| `dependent_order` | Rust test, no model | An edit of `a` and a read of `a` in the same assistant step run in emission order, not interleaved ahead of the edit |
| `no_quality_drop` | All three | `three_markers` fidelity matches a serial control on the same files. A missing marker is a fail even if the token count fell |

### Phase 6 results (2026-09-22)

What shipped:

- No new executor, no prompt change. The runner is the existing `FuturesUnordered` dispatch in `execute_tool_calls_batch` (`acp_session_impl/tool_calls.rs`): calls from one assistant response prepare, permission-check, then dispatch concurrently, with per-path file locks (`lock_path_for_args` → one `tokio::sync::Mutex` per written path) so calls touching a written path serialize.
- One Rust test added: `dependent_edit_then_read_in_one_batch_runs_in_emission_order` (`acp_session_tests/parallel_dispatch_tests.rs`), driving the real batch executor with the real `search_replace` + `read_file` tools against a temp file.

Rust cells (no model):

| Cell | Result | Pass |
|---|---|---|
| `dependent_order` | One batch of [edit `a` ("alpha"→"beta"), read `a`] runs in emission order: the read's tool result contains "beta" and not "alpha". The batch goes through the shipped dispatch, lock, and tool runtime — no test double on the execution path | yes |

Matrix, one model (bonsai2-27b per the run's instruction), three files with three distinct markers, headless turn `--allow 'Read(*)' --max-turns 8`:

| Cell | Result | Pass |
|---|---|---|
| `three_markers` | The parallel-allowed prompt ("you may issue the three reads together in one response") answers with all three markers (`MARKER-DELTA-7931`, `MARKER-EPSILON-4628`, `MARKER-ZETA-3174`); 3/3 found | yes |
| `no_quality_drop` | The serial control on the same files answers with the same three markers, 3/3 found — fidelity matches the parallel answer; no marker dropped | yes |

Notes:

- Raw logs: `~/.grok/long-running-background-tasks/cook-token-v2-phase6-20260922-144856/` (`run.log`, both `three_markers`/`serial_control` answer files, home `config.toml`).

## 10. Phase 7 — side calls stay until a matrix says otherwise

Do not turn off dream, memory capture, flush, the laziness classifier, prompt suggestion, or goal roles in this phase. Do not move them to Batch API. Recap, `/btw`, turn summary, and title refresh already share the parent cache key; leave that path.

Matrix, one normal headless coding prompt per model, long enough to read a file and answer. Inspect `usage.json`:

| Cell | Pass |
|---|---|
| `purposes_listed` | Every model call that ran has a purpose row. A purpose with tokens and a missing row is a fail. A purpose that did not run is absent, not zero |
| `task_still_correct` | The answer matches the prompt’s acceptance line. Side-call spend is recorded and is not a reason to delete the call |
| `no_new_uuid_policy` | This phase does not change conv ids. The matrix only records which purposes used a fresh id. A later phase may propose sharing the parent key, and that later phase needs its own matrix |

Disabling a side call is out of scope until a matrix with the call forced off matches `task_still_correct` on all three models and on the task class that call exists for. Goal verification on a long task is in that protected class.

## 11. What is deliberately not a phase

- Raising or lowering the product context window. It is already per model.
- Disabling two-pass prefire or verbatim compaction input to save tokens. Revisit only with a quality matrix of the same shape as phase 2, and only after phases 2 and 3.
- Shrinking the skill catalog below the point where a skill the user named is missing.
- A mega-tool that exists to reduce the tool count.
- An LLM summary after every tool result.
- Treating the v1 97.4% fixture drop, or the v1 live 27% prompt-token direction, as a default-on result. The live arm’s own billed input spanned 154,928 to 290,339 on one task.
- A cache-warm request (`maxTokens: 1` before a TTL). There is no per-model TTL here, and phase 4 has not reported hit and miss. The source comparison is [core-agent-vs-pi-coding-agent.md](core-agent-vs-pi-coding-agent.md).
- Turning prompt-cache writes off on the compaction request. Cook keeps the parent session id and the tool list so the summarizer prefix stays aligned (`session_compact.rs`). Another harness disables cache writes because its summary is a one-shot serialized transcript. Copying that would fight this prefix.
- Copying another harness’s tool-output numbers (50KB, 2,000 lines) or cutting the built-in catalog down to four tools.
- Rejecting a length-capped compaction summary. Cook labels that outcome `Truncated` and still completes. Changing that needs its own matrix. It is not a v2 phase. A truncated summary is not a clean checkpoint when a later matrix scores one.
- A `context_edit` store. Phase 2 already leaves canonical history unchanged and does not add an audit entry. An omission record, if one is added later, is an append. It is not this plan.

## 12. Commit rule

For each phase:

1. Implement only that phase. Defaults stay where the phase says they stay.
2. Run that phase’s matrix on `bonsai2-27b`, `mimo26-9b`, and `spark25-4b`, one at a time, stopping the model in between.
3. If any quality cell fails, do not commit the phase. Fix or revert. A failed cell stays in the notes of this file only when the commit is the record of a negative result the user asked to keep. Silence is not a pass.
4. If the quality cells pass, commit the phase and append the result table here. Include `unreported` cache cells as written. Do not average the three models into one saving.

Phase 1 has no product diff. Its commit is the result table in this file, and only after the six fidelity cells exist.
