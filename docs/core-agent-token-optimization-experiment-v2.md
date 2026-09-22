# Core agent token optimization, experiment v2

Date: **2026-09-22**.

Companion design: [core-agent-flow-and-token-optimization.md](core-agent-flow-and-token-optimization.md).

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

Rollback: nothing was changed. Stop the model.

## 5. Phase 2 — pin evidence before omitting more

The current step-aware arm keeps the newest tool round and whatever still fits the round and character budget. That is recency, not importance. v1 section 18 kept both markers on one read-file task and did not show that a failure buried in an older round survives.

Implementation, default still off:

- Carry provenance from tool execution into the request-copy pruner: exit status, whether the result is a failed check, whether a process is still live, and whether the result is the edit the assistant has not finished with. Do not classify this by scanning free-form log text.
- The active round stays raw, as it does now, even when one parallel batch exceeds the character budget.
- A pinned result stays raw even when it is outside the round window. If the pin plus the active round exceed the character budget, keep the pins and the active round, and say so in the placeholder for what was dropped. Do not drop a pin to honor the budget.
- Files: `crates/codegen/xai-chat-state/src/actor/request_builder.rs`, the pruning config in `crates/codegen/xai-chat-state/src/types.rs`, and the tool result that already knows exit status. No change to canonical history. No new public tool name.

Matrix. Quality cells only. The token columns are recorded and do not decide the commit.

| Cell | What it protects | How | Pass |
|---|---|---|---|
| `pin_old_failure` | A failing check that is not in the newest rounds | Endpoint fixture: rounds 1–6 are success noise except round 2, which is the only failure; rounds 7–8 are unrelated success. Omission policy on | All three models name round 2’s test and do not call the run clean |
| `active_round` | Evidence the model has not consumed | Existing request-builder tests, plus one endpoint prompt per model whose only real patch is in the last round | Active patch present in the answer; call id still paired in the Rust test |
| `live_markers` | The v1 live task still holds | `scripts/benchmark_step_pruning_live.sh` at `CONTEXT_WINDOW=40000`, `RUNS=1`, spark25-4b only until the live script’s wire name is configurable. Bonsai and mimo26 run `pin_old_failure` and `active_round` only | Both markers present, and the debug log shows the arm fired. A run with zero prune events is not a pass and not a fail of the policy; widen nothing, fix the window, rerun |
| `stale_read` | A file changed after it was read | One spark live turn: read a file, overwrite it, ask for the new line | The answer quotes the new line, not the pre-change line |

Phase 2 fails if any quality cell fails on any model that ran it. Leave the settings at zero in the default config. Commit the pin behavior and this matrix, not a default flip.

## 6. Phase 3 — append-only tool output

Shorten output when the tool produces it. Do not rewrite an earlier byte on the next sample. The sliding request-copy arm stays available and opt-in for comparison. It is not the design this phase turns on.

Implementation, flag default off:

- Bash already caps model-visible output and keeps a full log path. Read file can still return on the order of 25,000 estimated tokens. Add an opt-in generation cap for read-file output that keeps a head, a tail, the byte length, and a path the model can read again. The middle of a log is not silently discarded without that path.
- The active tool result is never capped below the evidence the model has not yet seen. Cap the *next* generation. Request-time pruning still must not eat the active round. v1 already states that.
- Files: `crates/codegen/xai-grok-tools/src/implementations/grok_build/read_file/mod.rs`, the bash truncate helper only if the existing cap cannot point at the full log, and a Cook config flag next to the existing pruning settings. Default off, so a session that does not set the flag is byte-identical to today.

Matrix:

| Cell | Models | Pass |
|---|---|---|
| `cap_off_identical` | Rust test, no model | Flag absent or zero. Read output matches the current helper |
| `cap_keeps_ends_and_path` | Rust test, no model | Over-cap read contains the first line, the last line, the omission notice, and a path. Call id unchanged |
| `middle_error_recoverable` | All three, endpoint | A file whose only error line sits in the middle. The model-visible body may omit it. The answer must still report that error after the prompt tells the model to open the saved path. Guessing “no error” is a fail |
| `prefix_stable` | All three, endpoint | Two identical follow-up requests after a capped tool result. `cache_warm` cached tokens, when reported, are greater than zero. A third request that rewrites an earlier result (the phase 2 sliding behavior, simulated in the prompt) is `cache_bust` and must show fewer cached tokens when both numbers exist |
| `live_spark_append` | spark25-4b only, live script, flag on in that home only | Both markers. Prune-event count may be zero, because this phase should not need a mid-history rewrite. Fidelity still required |

Do not lower `READ_FILE_MAX_TOKENS` globally in this phase.

## 7. Phase 4 — hit and miss in the session report

The ledger already stores cache reads, and `usage.json` already has `purposeUsage` and `requestComponents`. This phase only makes the uncached remainder explicit and refuses to treat “unreported” as zero.

Implementation:

- Where the provider usage includes cache reads inside input, the persisted report gains `uncachedInputTokens = input - cacheRead` for that call, plus a boolean `cacheFieldPresent`.
- Where the server omits the field, `cacheFieldPresent` is false and `uncachedInputTokens` is absent. Do not store 0.
- No change to what is sent to the model.
- Files: `crates/codegen/xai-chat-state/src/usage.rs`, `crates/codegen/xai-grok-shell/src/session/usage_file.rs`, and the existing usage-file tests.

Matrix, one short headless turn per model (`-p 'reply with exactly "ready"'`, `--output-format json`), then `usage <sessionId>`:

| Cell | Pass |
|---|---|
| `report_shape` | `purposeUsage` and `requestComponents` present on the session row. This is the v1 section 17 invariant, repeated per model |
| `cache_field_honest` | If the server sent cached tokens, the report shows them and the uncached remainder, and the remainder is not negative. If it did not, `cacheFieldPresent` is false and there is no zero standing in for the miss |
| `no_double_count` | One model call in the prompt does not appear as two purposes |

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

## 9. Phase 6 — independent reads in one realtime response

This is the batch that can reduce token count: several reads that do not depend on each other, issued in one model response, executed together. It is not Batch API. Section 3.5 of the design document already has the runner (`FuturesUnordered`). This phase does not add a new executor.

What it must not do: run an edit and the test that reads that edit in one parallel step, in an order that tests the old bytes. A path lock is not a full analysis of a shell command. If the dependency is not obvious from the arguments, run the calls in the order the model emitted them.

No prompt change in the default template until the matrix passes. The matrix itself may use a task prompt that *allows* parallel reads. That prompt is part of the harness, not a new default system prompt.

| Cell | Models | Pass |
|---|---|---|
| `three_markers` | All three, endpoint or live where the wire name works | Three files, three distinct markers. The answer contains all three. One round or three rounds are both passes |
| `dependent_order` | Rust test, no model | An edit of `a` and a read of `a` in the same assistant step run in emission order, not interleaved ahead of the edit |
| `no_quality_drop` | All three | `three_markers` fidelity matches a serial control on the same files. A missing marker is a fail even if the token count fell |

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

## 12. Commit rule

For each phase:

1. Implement only that phase. Defaults stay where the phase says they stay.
2. Run that phase’s matrix on `bonsai2-27b`, `mimo26-9b`, and `spark25-4b`, one at a time, stopping the model in between.
3. If any quality cell fails, do not commit the phase. Fix or revert. A failed cell stays in the notes of this file only when the commit is the record of a negative result the user asked to keep. Silence is not a pass.
4. If the quality cells pass, commit the phase and append the result table here. Include `unreported` cache cells as written. Do not average the three models into one saving.

Phase 1 has no product diff. Its commit is the result table in this file, and only after the six fidelity cells exist.
