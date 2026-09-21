# Core agent token-optimization experiment: implementation and reproduction guide

Date: **2026-09-21**

Branch: `experiment/core-agent-token-optimization`

Base revision: `a8b1874dd099802bdae334733d2828a5697b05cf`

Companion design: [core-agent-flow-and-token-optimization.md](core-agent-flow-and-token-optimization.md)

## 1. Outcome

This experiment implemented seven bounded changes:

1. A P0 accounting correction: a successful model response that omits usage now marks both the open prompt ledger and the session ledger incomplete. Unknown usage is no longer silently indistinguishable from a free call.
2. An opt-in P1 context arm: request-copy pruning can age tool results by tool round within one user turn and cap the recent raw-result characters. The legacy behavior remains the default because both new limits default to zero.
3. A P0 side-call accounting increment: every model call now carries a purpose, and compaction samples fold their provider usage into the session bill. Before this, compaction spend reached no ledger at all. See section 12.
4. A second P0 side-call increment: the four auxiliary calls that reuse the parent prompt cache — recap, turn summary, title refresh, and `/btw` — now fold their usage into the session bill under their own purposes. See section 13.
5. A third P0 side-call increment: the memory capture, dream, and flush calls, the laziness classifier, the goal evaluator, prompt suggestion, and the image-description vision call are accounted too, through one shared fold. See section 14.
6. A fourth P0 side-call increment: session title generation, the last call that reached no ledger, is accounted through a late-bound handle, because it runs in the persistence actor. See section 15. Every model call site in `xai-grok-shell` now reaches the session ledger.
7. A Step 1 measurement increment: every completed main-loop call now records the estimated composition of the request it sent — system, tool schemas, user, injected reminders, compaction meta, images, assistant, reasoning replay, and tool results — and the persisted session report shows the shares. See section 16.

Two of these increments changed only accounting; none changed what is sent to a model, which is why the pruning arm's measured result below is unaffected.

The local `bonsai2-27b` microbenchmark used a synthetic eight-round tool trace. The optimized trace reduced reported prompt input from 8,840 to 230 tokens (97.4%) while returning the same correct evidence and verdict in all three repetitions. This proves the fixture works and that its newest evidence survived. It does **not** prove a 97.4% saving on real coding tasks.

## 2. Scope and non-goals

The implemented arm targets the confirmed problem where many tool calls occur after one user message. Existing pruning measures age by `User` items, so every tool result in a long single-prompt loop can remain protected as “recent.”

This experiment does not:

- enable the new policy globally;
- change the provider-facing tool API or tool-call IDs;
- prune the canonical persisted conversation;
- add semantic classification of errors, patches, or evidence;
- implement the complete P0 call-purpose/component telemetry proposal;
- benchmark compaction, subagents, goals, cache pricing, or end-to-end accepted-task cost;
- claim production rollout readiness.

## 3. Files changed and why

| File | Change |
|---|---|
| `crates/codegen/xai-grok-shell/src/session/acp_session_impl/sampler_turn.rs` | Fail closed when a normal model response has `usage: None`. |
| `crates/codegen/xai-grok-shell/src/session/acp_session_tests/record_response_token_usage_tests.rs` | Verify prompt/session incomplete flags and unchanged context total. |
| `crates/codegen/xai-grok-config-types/src/memory.rs` | Parse and resolve the two opt-in pruning settings. |
| `crates/codegen/xai-chat-state/src/types.rs` | Carry the resolved settings into chat state; defaults are zero/off. |
| `crates/codegen/xai-grok-shell/src/session/acp_session_impl/spawn.rs` | Pass resolved settings from shell config to the chat-state actor. |
| `crates/codegen/xai-chat-state/src/actor/request_builder.rs` | Apply tool-round and character-budget pruning to the request copy and test compatibility/invariants. |
| `crates/codegen/xai-grok-shell/src/config/tests.rs` | Verify TOML parsing and resolution. |
| `crates/codegen/xai-grok-pager/docs/user-guide/13-memory.md` | Document the settings and opt-in example. |
| `scripts/benchmark_step_pruning.sh` | Reproducible local OpenAI-compatible A/B harness. |
| `docs/core-agent-flow-and-token-optimization.md` | Record the experiment summary and measured result. |

The side-call accounting increment in section 12 touches these files:

| File | Change |
|---|---|
| `crates/codegen/xai-chat-state/src/usage.rs` | Add `CallPurpose`, `by_purpose`, `side_call_model_calls`, and `usage_missing_calls`. |
| `crates/codegen/xai-chat-state/src/commands.rs`, `handle.rs`, `actor/mod.rs`, `actor/mutations.rs` | Carry a purpose into the ledger for side calls and for missing usage. |
| `crates/codegen/xai-grok-shell/src/session/helpers/session_compact.rs` | Capture provider usage from all three streaming backends; record it with a purpose. |
| `crates/codegen/xai-grok-shell/src/session/compaction.rs`, `helpers/full_replace_compaction.rs` | Label each compaction sample and report its usage. |
| `crates/codegen/xai-grok-shell/src/session/usage_file.rs` | Publish a per-purpose breakdown in the persisted session usage report. |
| `crates/codegen/xai-grok-shell/src/extensions/notification.rs`, `session/acp_session_impl/sampler_turn.rs` | Thread `usage_missing_calls`; count main-loop missing usage. |

The auxiliary side-call increment in section 13 touches these files:

| File | Change |
|---|---|
| `crates/codegen/xai-chat-state/src/usage.rs` | Add the `Recap`, `TurnSummary`, `TitleRefresh`, and `Btw` purposes. |
| `crates/codegen/xai-grok-shell/src/session/acp_session_impl/side_call.rs` | Add `record_auxiliary_call`, which logs the prompt-cache buckets and folds the usage under the call's purpose. |
| `crates/codegen/xai-grok-shell/src/session/acp_session_impl/recap.rs`, `turn_summary.rs`, `title_refresh.rs` | Route all four auxiliary calls through it. |
| `crates/codegen/xai-grok-shell/src/session/acp_session_tests/recap_display_only_tests.rs` | Assert the `/btw` ledger row from the existing end-to-end case. |

The remaining-call increment in section 14 touches these files:

| File | Change |
|---|---|
| `crates/codegen/xai-chat-state/src/usage.rs` | Add seven purposes: memory capture/dream/flush, laziness, goal evaluator, prompt suggestion, image describe. |
| `crates/codegen/xai-grok-shell/src/session/side_call_usage.rs` (new) | Hold the single usage-or-missing fold, `record_side_call_response`. |
| `crates/codegen/xai-grok-shell/src/session/acp_session_impl/side_call.rs` | `record_auxiliary_call` now delegates to the shared fold. |
| `crates/codegen/xai-grok-shell/src/session/acp_session_impl/laziness.rs`, `goal.rs`, `memory_dream.rs`, `memory_capture.rs`, `recap.rs` | Route the classifier, evaluator, dream, flush, extraction, and prompt-suggestion calls through the fold. |
| `crates/codegen/xai-grok-shell/src/session/image_describe.rs`, `acp_session_impl/prompt_build.rs` | Thread the ledger handle into the vision call and fold its usage. |

The title-generation increment in section 15 touches these files:

| File | Change |
|---|---|
| `crates/codegen/xai-chat-state/src/usage.rs` | Add the `SessionTitle` purpose. |
| `crates/codegen/xai-grok-shell/src/session/persistence.rs` | Give `PersistenceHandle` a late-bound `summary_chat_state` cell and hand it to every `SummaryConfig`. |
| `crates/codegen/xai-grok-shell/src/session/summary.rs` | Read the cell at call time and pass the handle to the title call. |
| `crates/codegen/xai-grok-shell/src/session/helpers/session_summary.rs` | Fold the title response under `SessionTitle`; accept an optional handle. |
| `crates/codegen/xai-grok-shell/src/session/acp_session_impl/spawn.rs` | Bind the handle once the chat-state actor exists. |

The component-estimate increment in section 16 touches these files:

| File | Change |
|---|---|
| `crates/codegen/xai-chat-state/src/request_components.rs` (new) | `RequestComponents`: the per-request estimate and its classifier. |
| `crates/codegen/xai-chat-state/src/actor/state.rs` | Split the user-item estimate into `(text, images)` so both callers share one arithmetic. |
| `crates/codegen/xai-chat-state/src/usage.rs`, `commands.rs`, `handle.rs`, `actor/{mod,mutations}.rs` | Record component sums on the session ledger. |
| `crates/codegen/xai-grok-shell/src/session/acp_session_impl/turn.rs`, `sampler_turn.rs` | Estimate the request after stripping and clamping, and fold it with the call's usage. |
| `crates/codegen/xai-grok-shell/src/session/usage_file.rs` | Publish a `requestComponents` block in the persisted session report. |

## 4. Accounting correction

### Previous behavior

`record_response_token_usage` recorded usage when the provider returned it. For missing usage, it marked accounting incomplete only in bounded-child/output-budget and retry-only contexts. A normal successful response with `usage: None` left both ledgers looking complete even though spend was unknown.

### New behavior

For every missing-usage main-loop response:

- the provider-reported context total remains unchanged because there is no trustworthy replacement value;
- model output still contributes to the separate estimated context growth path;
- prompt and session ledgers become incomplete;
- bounded task-output accounting still additionally exhausts/fails closed;
- no zero-token model call is fabricated.

The regression test verifies that `total_tokens` stays `99_999`, both incomplete flags become `true`, and `model_calls` remains zero because there was no reported usage record to fold.

## 5. Step-aware pruning design

### Configuration

The settings live under the existing pruning configuration:

```toml
[compaction.pruning]
enabled = true

# Existing user-turn policy
keep_last_n_turns = 3
soft_trim_threshold = 4000
soft_trim_head = 1500
soft_trim_tail = 1500
hard_clear_age_turns = 10

# New opt-in experiment policy
keep_last_n_tool_rounds = 6
recent_tool_result_char_budget = 64000
```

Both new values default to `0`. With both at zero, Cook follows the old user-turn-only behavior byte for byte. Set only one value to enable only that limit:

- `keep_last_n_tool_rounds > 0`: use a round window with no character cap;
- `recent_tool_result_char_budget > 0`: use a character cap with no round cap;
- both non-zero: a prior raw result must pass both limits.

The proposed `64,000` characters correspond to roughly 16,000 estimated tokens under the current bytes/4 approximation. Unicode and JSON-heavy output can tokenize differently, so this is not an exact tokenizer budget.

### Request-time algorithm

Pruning still runs only when tracked context usage is above half of the model context window. When it runs, it operates on the cloned request items:

1. Walk the conversation backward.
2. Count `User` items using the existing turn-age behavior.
3. Count assistant items with tool calls as tool-round boundaries.
4. Treat the newest tool round as index 0 and always retain all results in that active round.
5. Accumulate tool-result characters from newest to oldest.
6. For results in otherwise protected recent user turns:
   - keep the result if it is active; or
   - keep it if it is inside every enabled round and character limit; otherwise
   - replace only its content with `[Tool result omitted — outside recent step budget]`.
7. Apply the existing soft-trim and hard-clear rules to older user turns.

Assistant tool calls and `ToolResult` items are not removed. Their ordering and call IDs remain intact, so provider request-history validation still sees a result for each call.

### Example

Assume eight sequential tool rounds, each result is 200 characters, `keep_last_n_tool_rounds = 3`, and `recent_tool_result_char_budget = 450`:

| Newest-relative index | Cumulative chars | Round limit | Character limit | Result |
|---:|---:|---|---|---|
| 0 (active) | 200 | pass | pass | keep raw |
| 1 | 400 | pass | pass | keep raw |
| 2 | 600 | pass | fail | omit content |
| 3–7 | >600 | fail | fail | omit content |

The active round is intentionally privileged even if one parallel batch exceeds the configured character budget. Generation-time tool caps are the appropriate way to bound that batch; request-time pruning must not discard evidence that the model has not yet had a chance to consume.

### Storage and recovery behavior

The pruning arm mutates only the model request copy. It does not rewrite `updates.jsonl` or the canonical live conversation, so full evidence remains available to replay and audit. This arm does **not** add a model-callable restoration handle for an arbitrary omitted result; the model may need to repeat a safe read or command. Adding scoped artifact handles and measuring reread cost are prerequisites for broader rollout. The existing eager retained-history hard-clear for very old user turns is unchanged.

## 6. Reproducing the Rust verification

From the repository root:

```bash
git switch experiment/core-agent-token-optimization

# Full request-building/pruning suite
cargo test -p xai-chat-state --lib

# Full typed-config suite
cargo test -p xai-grok-config-types --lib

# Missing-usage accounting tests
cargo test -p xai-grok-shell --lib response_without_usage

# New pruning config parse/resolution
cargo test -p xai-grok-shell --lib memory_config_full_toml_parsing

# Cross-crate type/build integration
cargo check -p xai-grok-shell -p xai-grok-pager -p xai-grok-sampling-types

# Script syntax and patch hygiene
bash -n scripts/benchmark_step_pruning.sh
git diff --check
```

Observed results on 2026-09-21:

| Command | Result |
|---|---|
| `cargo test -p xai-chat-state --lib` | 369 passed |
| `cargo test -p xai-grok-config-types --lib` | 75 passed |
| shell filter `response_without_usage` | 2 passed |
| shell filter `memory_config_full_toml_parsing` | 1 passed |
| cross-crate `cargo check` | passed |
| benchmark script `bash -n` | passed |
| `git diff --check` | passed |

The most important new unit cases are:

- eight tool rounds under one user prompt obey the tool-round and character limits;
- the active round remains raw;
- all eight tool results remain present, preserving call/result pairing;
- zero step limits preserve legacy recent-turn behavior;
- missing usage marks both ledgers incomplete without changing the last reported context total.

## 7. Reproducing the local `bonsai2-27b` experiment

### Prerequisites

- An OpenAI-compatible llama.cpp server.
- Model `Ternary-Bonsai-2-27B-PQ2_0.gguf` or the equivalent Bonsai 2 27B build.
- Server alias `bonsai2`, or set `BONSAI_MODEL` to your alias.
- `curl` and `jq`.

An equivalent server shape is:

```bash
llama-server \
  -m /path/to/Ternary-Bonsai-2-27B-PQ2_0.gguf \
  --alias bonsai2 \
  --host 127.0.0.1 \
  --port 8080 \
  -c 131072 \
  --jinja \
  --api-key "$BONSAI_API_KEY"
```

Do not commit or paste the API key into the report. To avoid saving it in shell history:

```bash
read -rsp 'Local model API key: ' BONSAI_API_KEY
echo
export BONSAI_API_KEY
```

Check connectivity:

```bash
curl --fail --silent \
  -H "Authorization: Bearer ${BONSAI_API_KEY}" \
  http://127.0.0.1:8080/v1/models | jq .
```

### Run the benchmark

```bash
BONSAI_BASE_URL=http://127.0.0.1:8080/v1 \
BONSAI_MODEL=bonsai2 \
RUNS=3 \
REASONING_EFFORT=none \
MAX_TOKENS=160 \
scripts/benchmark_step_pruning.sh
```

The script prints tab-separated rows containing arm, run, prompt/completion/total tokens, whole-second latency, and the model answer.

### Fixture and acceptance rule

- Baseline: rounds 1–6 contain large stale successful-build logs; rounds 7–8 contain the current failing test, expected/actual state, patch, and passing regression.
- Optimized: rounds 1–6 use the runtime omission marker; rounds 7–8 are identical to baseline.
- Pass: the model returns `PASS`, names `response_without_usage_preserves_context_and_marks_ledgers_incomplete`, and preserves the expected incomplete-ledger facts.

### Observed output

Every baseline and optimized repetition returned the same answer:

```json
{
  "verdict": "PASS",
  "test": "response_without_usage_preserves_context_and_marks_ledgers_incomplete",
  "expected": "prompt.incomplete=true and session.incomplete=true",
  "actual": "patch changes the usage=None fallback to call mark_usage_incomplete_nowait(true, true); the focused regression test passes"
}
```

| Metric | Baseline runs | Optimized runs |
|---|---|---|
| Correct result | 3/3 | 3/3 |
| Prompt tokens | 8,840 each | 230 each |
| Completion tokens | 78 each | 78 each |
| Total tokens | 8,918 each | 308 each |
| Latency | 3 s, 2 s, 2 s | 3 s, 2 s, 2 s |

Calculations:

```text
prompt reduction = (8840 - 230) / 8840 = 97.4%
total reduction  = (8918 - 308) / 8918 = 96.5%
median latency   = 2 seconds in both arms
```

### Troubleshooting learned during the run

The server was launched with medium reasoning as a template default. Initial requests with 160, 512, and 1,024 completion tokens returned no visible final answer because the model used the entire cap in its reasoning channel. The valid benchmark therefore sets `reasoning_effort = "none"` both as a request field and in `chat_template_kwargs`. This isolates context-retention behavior instead of measuring reasoning-budget behavior.

The first harness version also used wall-clock millisecond subtraction. This host's wall clock produced invalid elapsed values, so the committed harness uses Bash's monotonic `SECONDS` counter and reports whole seconds.

A separate model review initially claimed the third-newest result exposed a round-window off-by-one. That review ignored the simultaneous character budget: three 200-character results total 600 characters, exceeding the configured 450. A focused follow-up correctly rejected the claimed defect. Deterministic Rust tests, not model review, remain the acceptance authority.

## 8. Interpreting the result correctly

The large percentage is expected because the fixture deliberately puts almost all input volume in stale logs. It answers one narrow question: can the proposed omission policy drastically reduce this confirmed pathological shape without losing the newest evidence in this fixture?

It does not answer:

- how often real Cook sessions have this shape;
- whether omitted output causes rereads later;
- whether an error in the middle of an older log is needed;
- whether provider cache discounts change the cost result;
- whether the policy improves cost per accepted task;
- whether 64,000 characters and six rounds are the best settings;
- whether Unicode, images, parallel tool batches, resume, rewind, or compaction change the quality result.
- whether missing restoration handles create unacceptable reread cost or make non-repeatable output unavailable to the model.

Keep the settings opt-in until those questions have evidence.

## 9. Rollback and safety

No code rollback is required to disable the experiment. Use either:

```toml
[compaction.pruning]
keep_last_n_tool_rounds = 0
recent_tool_result_char_budget = 0
```

or disable all tool-result pruning:

```toml
[compaction.pruning]
enabled = false
```

The first option returns to the legacy user-turn-only pruning behavior. The second disables existing soft trim and hard clear too, so prefer zeroing only the experimental fields when isolating a regression.

## 10. Detailed next plan

### Step 1: finish the P0 baseline before judging savings

Progress on 2026-09-21: the confirmed gap — compaction spend reaching no ledger — is closed for the compaction purposes. See section 12. The four auxiliary calls that reuse the parent prompt cache (recap, title refresh, turn summary, `/btw`) are closed too, as are the memory capture/dream/flush calls, the laziness classifier, the goal evaluator, prompt suggestion, and image description (sections 13 and 14), and finally session title generation (section 15). Every model call site in `xai-grok-shell` now folds its provider usage into the session ledger under a purpose, and every completed main-loop call records the estimated composition of the request it sent (section 16), so **both halves of Step 1 are done**. The session report now reconciles in two dimensions: by call purpose, and by request component.

Add a purpose and identity record for every model call without creating a second billing ledger. At minimum distinguish main loop, transient retry, compact single/pass 1/pass 2, goal roles, memory, suggestion, and child calls. Record:

- session, prompt, request, attempt, parent/child, model, backend, profile;
- estimated request components: system/rules, skill catalog, tool schemas, user, assistant/reasoning replay, tool results, images, compact summary;
- reported input/cache-read/cache-write/output/reasoning usage;
- `usage_missing`, `cost_missing`, incomplete, live-child, and unaccounted-side-call flags;
- request and task wall time, outcome, retry cause, and prefix-change reason.

Acceptance: one task report reconciles with the existing ledger, missing usage is visible, and child usage is not double-counted.

### Step 2: build a fixed real-task corpus

Create 30–50 tasks across:

- one-file fixes;
- failures requiring tests;
- repository exploration;
- multi-file refactors;
- long tasks that approach compaction;
- resume/interjection;
- skills/MCP;
- goals with children;
- a large repository and Vietnamese/Unicode content.

Pin repository revision, permissions, model parameters, acceptance commands, and environment. Run at least three repetitions per arm. Keep failed attempts in the spend denominator.

### Step 3: compare baseline and step-aware arms

Use these initial arms:

| Arm | Settings |
|---|---|
| A | Both new settings `0` |
| B | 6 rounds, 64,000 chars |
| C | 4 rounds, 48,000 chars |
| D | 3 rounds, 32,000 chars |

For each run, record accepted/not accepted, raw and uncached input, completion/reasoning, call count by purpose, reread tokens, retries, p50/p95 latency, compaction count/stall, and peak context.

### Step 4: add fidelity-aware pins before broader rollout

The current experiment protects recency, not semantics. Add explicit metadata/pins for:

- the latest failing verification;
- output from live processes;
- patch-preparation snippets and active edit evidence;
- results explicitly referenced by later assistant reasoning;
- artifact path, command/range, exit status, truncation state, and content hash.

Do not infer all of this from free-form output text. Carry provenance from tool execution where possible. Add tests for middle-of-log errors and stale file reads after writes.

### Step 5: measure reread and cache effects

Track when the model re-reads an artifact or file range after omission. Hash stable prefix components and correlate prefix changes with provider cache reads. A smaller prompt that destroys cache reuse or triggers repeated file reads may cost more despite lower raw input.

### Step 6: decide whether to roll out

Use the design document's gate:

- at least 20% lower cost per accepted task;
- success-rate loss below 2 percentage points, with confidence intervals that can resolve the difference;
- p95 latency increase below 10%;
- no permission, requirement, patch, resume, replay, or false-completion regression.

If the gate passes, expose a named cost-conscious profile first, retain zero-value rollback, and stage rollout by model/backend. If it fails, keep the accounting improvements and revert/leave disabled the step-aware arm while using the collected traces to choose the next experiment.

## 11. Suggested follow-up command checklist

```bash
# Confirm the branch and clean starting point
git status --short --branch

# Re-run correctness checks
cargo test -p xai-chat-state --lib
cargo test -p xai-grok-config-types --lib
cargo test -p xai-grok-shell --lib response_without_usage
cargo test -p xai-grok-shell --lib memory_config_full_toml_parsing
cargo check -p xai-grok-shell -p xai-grok-pager -p xai-grok-sampling-types

# Re-run the local A/B microbenchmark
read -rsp 'Local model API key: ' BONSAI_API_KEY
echo
export BONSAI_API_KEY
RUNS=3 scripts/benchmark_step_pruning.sh

# Review exactly what will be committed
git diff --check
git diff --stat
git diff

# Commit after all checks pass
git add \
  crates/codegen/xai-chat-state/src/actor/request_builder.rs \
  crates/codegen/xai-chat-state/src/types.rs \
  crates/codegen/xai-grok-config-types/src/memory.rs \
  crates/codegen/xai-grok-pager/docs/user-guide/13-memory.md \
  crates/codegen/xai-grok-shell/src/config/tests.rs \
  crates/codegen/xai-grok-shell/src/session/acp_session_impl/sampler_turn.rs \
  crates/codegen/xai-grok-shell/src/session/acp_session_impl/spawn.rs \
  crates/codegen/xai-grok-shell/src/session/acp_session_tests/record_response_token_usage_tests.rs \
  docs/core-agent-flow-and-token-optimization.md \
  docs/core-agent-token-optimization-experiment.md \
  scripts/benchmark_step_pruning.sh
git commit -m "experiment step-aware tool result pruning"
```

## 12. P0 side-call accounting: purpose-labelled model calls

Date: **2026-09-21**. Follow-up to the missing-usage correction in section 4.

### The gap

`UsageLedger` had no record of compaction at all. The module documented the omission as intentional ("Compaction and other side calls never call `record_main_loop_call`"), but nothing recorded them anywhere else either: `generate_session_compact` consumed the summary text out of the response stream and dropped the `usage` field on the floor. A session that compacted five times reported a bill that excluded all five summarizer calls, and nothing in the report distinguished "no compaction happened" from "compaction happened and was not counted."

The same omission applies to the recap, title-refresh, turn-summary, memory, and goal-role helpers, which are not covered here.

### What changed

Every model call now carries a `CallPurpose`:

| Purpose | Meaning |
|---|---|
| `MainLoop` | The main agent tool loop. The only purpose that advances `main_loop_model_calls`, which is the reported turn count. |
| `CompactSingle` | One compaction sample through the single-pass / full-replace engine. |
| `CompactPass1` | Two-pass pass 1, the speculative prefire summary. |
| `CompactPass2` | Two-pass pass 2, the summary the successor actually sees. |
| `Subagent` | Child work folded from a child session ledger. |

The ledger folds side calls into the same `totals` and `by_model` it already kept, and adds `by_purpose` plus `side_call_model_calls`. A separate purpose row is what makes the session total reconcile: main-loop plus subagent plus side calls now equals the reported totals, and a compaction summary can no longer arrive as an unexplained gap.

`UsageTotals` also gained `usage_missing_calls`. A call that completes and reports no usage is counted as unknown in both the totals and its purpose row. It never adds tokens, never adds a model call, and marks the session bill incomplete — the same rule the main-loop correction in section 4 applies.

Separating pass 1 from pass 2 matters for the compaction experiment: prefire spend that a discarded NOTE₁ wastes is now attributable to `compact_pass1` instead of being merged into the cost of the summary that was used.

### Capturing usage

`generate_session_compact` now returns `usage` and `cost_usd_ticks` on `CompactOutput`. Extraction is per backend, matching the Layer-2 transforms in `xai-grok-sampler`:

- **Chat Completions**: the final chunk's `usage`, last-write-wins because the wire value is cumulative; `cost_in_usd_ticks` when present.
- **Responses**: the terminal `response.completed` frame's `usage`.
- **Messages**: prompt input from `message_start`, output from the terminal `message_delta`. `prompt_tokens` is the sum of the uncached, cache-read, and cache-creation buckets, so it matches the main-loop convention.

An all-zero Messages frame set is treated as unreported rather than as a free call.

### Where a report shows it

The persisted per-session usage report (`usage.json`) gained a `purposeUsage` map keyed by [`CallPurpose::as_str`](../crates/codegen/xai-chat-state/src/usage.rs). The session row now reads like:

```json
{
  "session": {
    "inputTokens": 1204000,
    "modelCalls": 42,
    "purposeUsage": {
      "main_loop":      { "inputTokens": 1180000, "modelCalls": 40 },
      "compact_single": { "inputTokens": 24000, "modelCalls": 2 }
    }
  }
}
```

`main_loop` and the session's `turnCount` agree, and compaction is visible as its own line.

### Verification

| Check | Result |
|---|---|
| `cargo test -p xai-chat-state --lib` | 373 passed (369 before; 4 new ledger cases) |
| `cargo test -p xai-grok-config-types --lib` | 75 passed |
| `cargo test -p xai-grok-shell --lib` | 6993–6994 passed, 5–6 failed — the same failures occur on the base revision with these changes stashed |
| `cargo check -p xai-grok-shell -p xai-grok-pager -p xai-grok-sampling-types` | passed |

New cases, by what they pin:

- the ledger folds side calls into totals without advancing the turn count, and leaves unused purposes absent rather than as zero rows;
- missing usage is counted per purpose and fabricates neither tokens nor model calls;
- a Chat Completions compaction captures the final chunk's usage, and a stream with no usage leaves it `None`;
- a Responses compaction captures the terminal frame's usage;
- the Messages mapping folds cache buckets and rejects an all-zero frame set;
- one round through the real full-replace sampler against a live SSE server lands in the session ledger as `compact_single` with `main_loop_model_calls` still zero;
- the persisted session report breaks the bill down by purpose, keeps a row for usage that never arrived, and round-trips through serde under the `purposeUsage` key.

### Failures observed that are not caused by this change

Five `xai-grok-shell` tests fail on the branch tip before this increment (`609a216e`) with these changes stashed, and fail identically here: `goal_use_current_model_only_env_{true,false}`, both `validate_hooks_path_rejects_*` cases, and `parse_list_req_forces_kind_under_process_chat_mode_only`. A sixth, `set_consent_answer_is_monotonic_per_account`, shares a real on-disk config location and fails intermittently in a full parallel run on both revisions; it passes in isolation on both.

The suite also overflows the stack in `agent::mvp_agent::tests::adopting_attach_waits_for_the_installed_actors_stamp` on this host. That reproduces on `609a216e` with these changes stashed, so it is not attributable here; `RUST_MIN_STACK=33554432` avoids it.

### A verification case that was written and then removed

An earlier revision also asserted the ledger from a real `SessionActor::run_compact` on the `compaction_inline_auto_compact_flow_tests` harness. It verified its target, but it made the suite worse: with that one test present, `agent::mvp_agent::tests::exhausted_fetch_decides_on_the_local_layers` failed in three of four full parallel runs, and passed in every run of `609a216e` and in every run with the test removed. It passes in isolation on both revisions, sets no environment variable, and mutates no shared state, so the mechanism was not root-caused — standing up one more full `SessionActor` beside a live mock server is enough to shift scheduling in a suite that already has order-sensitive tests. The case was dropped because the sampler-level test above already covers the recording call, and one extra hop through `run_compact` is not worth destabilizing a fragile suite. The finding is recorded rather than a `#[serial]` marker applied in the hope that it helps.

### What this does not establish

- The size of the previously invisible compaction spend on a real session is still unmeasured. Nothing here quantifies how much of a real bill was missing.
- Side calls are folded into the session ledger only. They are still absent from the per-prompt ledger that the ACP wire reports, so a per-prompt `usage` figure remains a main-loop figure.
- Recap, title-refresh, turn-summary, memory, and goal-role calls still reach no ledger. The purpose enum does not name them yet. Section 13 closes this for recap, title refresh, turn summary, and `/btw`; the rest are still open.
- A compaction attempt that fails before completing is not recorded at all. Only completed samples are. A retry ladder that burns several failed attempts still under-counts; the design document's "record unknown, not zero" rule is not yet applied to failed streams.
- Cost is captured only where the wire reports it, which in practice means Chat Completions. A compaction sample on the Responses or Messages backend folds its tokens with no cost, so a session whose only compaction ran there reports tokens without a price.

## 13. P0 side-call accounting: the four prompt-cache-sharing auxiliary calls

Date: **2026-09-21**. Completes section 12 for the auxiliary calls that reuse the parent turn's prompt cache.

### The gap

Section 12 gave the ledger a purpose for compaction but left the auxiliary calls unaccounted. Four of them already shared the same request skeleton (recap, turn summary, title refresh, `/btw`) and already logged their provider-reported prompt-cache buckets under a fixed label, but nothing anywhere recorded the tokens or the cost. A session that ran six recaps, a title refresh per checkpoint, and a turn summary after every turn reported a bill that excluded every one of them.

The omission was invisible in a second way: the report could not distinguish a session that made no auxiliary calls from one whose auxiliary spend was dropped.

### What changed

`CallPurpose` gained four variants, and `record_auxiliary_call` in `session/acp_session_impl/side_call.rs` is now the single entry point for these calls. It logs the prompt-cache buckets exactly as before and folds the response's usage into the session ledger under the call's purpose.

| Call site | Purpose | Model source |
|---|---|---|
| `recap.rs` `/btw` side question | `btw` | the session's sampling config |
| `recap.rs` recap summary | `recap` | the session's sampling config |
| `turn_summary.rs` per-turn narrative | `turn_summary` | `SideCallSetup::model` |
| `title_refresh.rs` title refresh | `title_refresh` | `SideCallSetup::model` |

Three properties are deliberate:

- **The purpose string is the existing tracing label.** `record_auxiliary_call` passes `purpose.as_str()` to the same `log_prompt_cache_usage` these sites already called, and the four new strings are byte-identical to the labels that were in the source. The `auxiliary call prompt cache usage` log line is unchanged, so the accounting change adds no new telemetry vocabulary.
- **A response without usage is counted as missing.** Same rule as section 12: the purpose row's `usage_missing_calls` advances, no tokens and no `model_calls` are invented, and the session bill is marked incomplete. The call happened and cost something, so it must not read as free.
- **Nothing advances the turn count.** All four fold into `side_call_model_calls` and their own `by_purpose` row; `main_loop_model_calls` — the reported turn count — is untouched.

Duration is passed as `None` because none of the four sites has a start timestamp in scope, so `api_duration_ms` stays 0 for these rows. That is a gap, not a measurement of zero.

### Where a report shows it

The `purposeUsage` map from section 12 now carries the auxiliary rows:

```json
{
  "session": {
    "modelCalls": 42,
    "purposeUsage": {
      "main_loop":    { "inputTokens": 1180000, "modelCalls": 40 },
      "recap":        { "inputTokens": 41000, "modelCalls": 1 },
      "title_refresh":{ "inputTokens": 9200, "modelCalls": 1 }
    }
  }
}
```

### Verification

| Check | Result |
|---|---|
| `cargo test -p xai-chat-state --lib` | 374 passed (373 before; 1 new ledger case, 1 label case extended) |
| `cargo test -p xai-grok-shell --lib` | 6995 passed, 5 failed — the same five failures occur on the base revision (see section 12) |
| `cargo check -p xai-grok-shell -p xai-grok-pager -p xai-grok-sampling-types` | passed |
| `rustfmt --check` on the six touched files | clean |

New and extended cases, by what they pin:

- `auxiliary_call_usage_folds_under_its_own_purpose` drives `record_auxiliary_call` through a real `ChatStateActor` twice, once with usage and once without, and asserts the recap row's tokens, the title-refresh row's `usage_missing_calls`, `side_call_model_calls == 1`, `main_loop_model_calls == 0`, and that the session bill is incomplete.
- `auxiliary_purposes_fold_outside_the_main_loop` pins `is_main_loop() == false` for all four, so none can be routed through `record_main_loop_call` without tripping the ledger's debug assertion.
- `purpose_labels_are_stable` now pins all nine strings, with a note that the four auxiliary labels must not drift from the tracing labels.
- `side_question_projects_agent_messages_without_mutating_history` was the existing end-to-end `/btw` case against `MockInferenceServer`; it now also asserts the session ledger. This is the check that the wiring is real rather than only type-correct: the purpose reaches the ledger from an actual `handle_side_question` call, through the actual model response, with the history left byte-identical. No new actor or server was stood up for it, which matters given the suite instability recorded in section 12.

### What this does not establish

- The size of the previously invisible auxiliary spend on a real session is still unmeasured.
- The remaining model calls outside the main loop still reach no ledger: memory capture, the two memory-dream calls, the laziness judge, image description, the goal evaluator, session title generation, and prompt suggestion. The goal evaluator already detects and marks missing usage but records nothing when usage is present, so its spend is invisible either way.
- Failed auxiliary attempts are still unrecorded. Only a completed call reaches `record_auxiliary_call`, and `/btw`'s retry ladder in particular can burn several attempts that appear nowhere.
- Duration is absent for all four, and cost is absent wherever the wire does not report it.
- As in section 12, these calls remain absent from the per-prompt ACP wire ledger, so a per-prompt `usage` figure is still a main-loop figure.

## 14. P0 side-call accounting: the remaining model calls

Date: **2026-09-21**. Closes section 13's list of unaccounted calls except session title generation.

### The gap

After sections 12 and 13, a model call could still be invisible. An audit of every `conversation_collect` call site in `xai-grok-shell` found fourteen; compaction (three purposes) and the four prompt-cache-sharing auxiliary calls were accounted, the main loop records its own usage through `record_response_token_usage`, and these seven were not:

| Call site | Why it spends |
|---|---|
| `memory_capture.rs` extraction worker | Summarizes a turn range into memory observations on every capture attempt. |
| `memory_dream.rs` `run_dream_model_call` | The `/dream` consolidation call. |
| `memory_dream.rs` `run_memory_flush` | The periodic flush turn that writes a session log. |
| `laziness.rs` `maybe_fire_laziness_check` | The classifier that decides whether to nudge. |
| `goal.rs` `evaluate_goal_round` | The goal evaluator, retried up to twice per round. |
| `recap.rs` `handle_suggest_prompt` | The prompt-suggestion call. |
| `image_describe.rs` `describe_user_images` | The vision call that transcribes a user's attached image. |

Two of these were partially accounted already, which is what made the gap easy to miss. The goal evaluator detected a response with no usage and marked the bill incomplete, but recorded nothing when usage *was* present, so its spend was invisible either way. The memory-capture extractor computed usage and attached it to the memory telemetry record, but that record is a memory log, not the session bill.

### What changed

The fold moved into its own module, `session/side_call_usage.rs`. `record_side_call_response(handle, purpose, model, response, api_duration_ms)` is now the single place that decides between "fold these tokens" and "count this call as unknown", so a new call site cannot invent a third behavior. `record_auxiliary_call` from section 13 is a thin wrapper over it that adds the prompt-cache bucket log.

`CallPurpose` grew seven variants to sixteen: `MemoryCapture`, `MemoryDream`, `MemoryFlush`, `Laziness`, `GoalEvaluator`, `PromptSuggestion`, and `ImageDescribe`.

Two sites needed more than a one-line insertion:

- **Image describe** was a pure transport helper with no ledger access. The handle is now threaded through `get_or_describe` and `describe_user_images`, and the ledger fold happens in `describe_user_images` where the response lives.
- **Memory flush** runs on a `tokio::spawn`ed task on the multi-threaded runtime, so the chat-state handle and the resolved model name are cloned into the task.

Durations are passed where the call site already measures one: the laziness classifier passes its elapsed wall time (which wraps the generation-poll loop, not only the HTTP call) and prompt suggestion passes its latency. The other five pass `None`.

### Verification

| Check | Result |
|---|---|
| `cargo test -p xai-chat-state --lib` | 374 passed |
| `cargo test -p xai-grok-shell --lib` | 6996 passed, 5 failed — the same five failures occur on the base revision (see section 12) |
| `cargo check -p xai-grok-shell -p xai-grok-pager -p xai-grok-sampling-types` | passed |
| `rustfmt --check` on the touched files | clean |

New cases, by what they pin:

- `side_call_usage::tests::side_call_usage_folds_under_its_own_purpose` drives the shared fold through a real `ChatStateActor` twice: once with usage and a duration, and once with no usage. It asserts the tokens, the recorded `api_duration_ms`, the missing-usage counter, `side_call_model_calls == 1`, `main_loop_model_calls == 0`, and that the bill is marked incomplete.
- `describe_folds_usage_under_image_describe` is end to end through the real `describe_user_images`, a real `ChatStateActor`, and a real SSE response. It is the check that the threaded handle actually reaches the ledger, and it pins the tokens, the cost, and the untouched turn count.
- `auxiliary_purposes_fold_outside_the_main_loop` now iterates every non-main-loop purpose in `CallPurpose::ALL` and folds each through `record_side_call`, so a purpose misclassified as main-loop fails the ledger's own debug assertion rather than passing silently.
- `purpose_labels_are_stable` pins all sixteen strings.

The remaining six sites have no test harness that produces a successful model response — the laziness integration tests deliberately point at a non-listening URL and pin the abort arms only, and the memory, goal, and prompt-suggestion tests do not stand up a model server. Their verification here is the compiler plus the shared fold's unit and end-to-end coverage, which is weaker than the case for image describe. The choice was deliberate: writing six new actor-plus-server harnesses was the change that made the suite unstable in section 12.

### What this does not establish

- **Session title generation is still unaccounted.** `session_summary::generate_session_summary` runs in the persistence actor, whose `SummaryConfig` carries no chat-state handle; accounting for it means plumbing one through that actor's construction. It is the last known unaccounted model call.
- The size of the newly attributed spend on a real session is unmeasured. Nothing here quantifies how much of a real bill was missing.
- Failed attempts are still unrecorded. Only a completed call reaches `record_side_call_response`, so a retry ladder — the goal evaluator retries twice per round, `/btw` retries on transient failures — burns attempts that appear nowhere.
- Duration is absent for five of the seven sites, and cost is absent wherever the wire does not report it.
- These calls remain absent from the per-prompt ACP wire ledger, so a per-prompt `usage` figure is still a main-loop figure.
- The audit covers `xai-grok-shell`. Model calls made by other crates are out of scope and unaudited.

## 15. P0 side-call accounting: session title generation

Date: **2026-09-21**. Closes the last known unaccounted model call, so purpose coverage is complete.

### The gap

`session_summary::generate_session_summary` generates a session's first title from the opening user message, and it runs in the **persistence actor**, not the session actor. That placement is deliberate (it keeps the title call off the persistence actor's critical path via a spawned task), and it is exactly what made the call unaccountable: the persistence actor holds no chat-state handle, and it is constructed *before* the chat-state actor exists, so there is no point during setup where both are in hand.

### What changed

The handle is late-bound instead of plumbed.

- `PersistenceHandle` gained `summary_chat_state`, an `Arc<OnceLock<ChatStateHandle>>`. `actor_channel()`, `noop()`, and the test-only `from_parts_for_test` each create an empty cell.
- All three `persistence.rs` constructor sites that build a `SummaryConfig` clone that exact cell into it, so the generator shares the cell with the handle rather than owning a private one.
- `spawn.rs` calls `persistence.bind_summary_chat_state(&chat_state_handle)` immediately after the chat-state actor is created. Later binds are ignored, so a rebind cannot repoint an already-bound ledger.
- `SummaryGenerator::update` reads the cell when it spawns the title task and passes `Option<&ChatStateHandle>` down to `generate_session_summary`, which folds the response under the new `SessionTitle` purpose.

An unbound cell degrades to an unaccounted call, never to an error or a lost title: the title path must not depend on accounting being wired.

`CallPurpose` now has seventeen variants — the main loop, four compaction purposes, subagent folding, and eleven side-call purposes.

### Verification

| Check | Result |
|---|---|
| `cargo test -p xai-chat-state --lib` | 374 passed |
| `cargo test -p xai-grok-shell --lib` | 6999 passed, 5 failed — the same five failures occur on the base revision (see section 12) |
| `cargo check -p xai-grok-shell -p xai-grok-pager -p xai-grok-sampling-types` | passed |
| `rustfmt --check` on the touched files, `git diff --check` | clean |

New cases, by what they pin:

- `generated_title_folds_usage_under_session_title` drives the real `generate_session_summary` against a real chat-state actor and a real SSE response, and asserts the `session_title` row's tokens, the cost, `side_call_model_calls == 1`, and an untouched turn count.
- `generated_title_without_a_handle_falls_back_without_panicking` pins the degradation contract: no bound handle, no panic, and the caller still gets the fallback title.
- `update_folds_the_title_call_into_the_bound_ledger` drives `SummaryGenerator::update` — the production caller, including the cell read and the clone into the spawned task — and orders its ledger assertion behind the `GeneratedTitle` message the actor emits, so it does not depend on a sleep.
- `purpose_labels_are_stable` pins all seventeen strings.

### What this does not establish

- **The cell-sharing link between `PersistenceHandle` and `SummaryConfig` is not covered by a test.** It is a one-line clone at each of the three constructor sites, verified by reading and by compilation, but a future edit could substitute a fresh `OnceLock` and silently un-account the title call again. Everything downstream of the cell is tested.
- The size of the newly attributed spend on a real session is unmeasured.
- Failed attempts are still unrecorded across every purpose: only a completed call reaches `record_side_call_response`.
- Duration is absent for this site and five others, and cost is absent wherever the wire does not report it.
- These calls remain absent from the per-prompt ACP wire ledger, so a per-prompt `usage` figure is still a main-loop figure.
- The audit covers `xai-grok-shell`'s own calls. Model calls made by other crates, and any future call site added without a purpose, are outside it.

## 16. Per-request component estimates

Date: **2026-09-21**. The other half of Step 1: what a prompt is *made of*, not just what it cost.

### The gap

The ledger said how many tokens a session spent but nothing about where they went. That is the wrong instrument for the step-aware pruning arm: pruning changes tool results specifically, so judging it needs to know what share of a prompt is tool results versus system prompt and tool schemas, which pruning cannot touch. Section 10 lists the intended components (system/rules, tool catalog, tool schemas, user, assistant/reasoning replay, tool results, images, compact summary) and nothing measured any of them.

### What changed

A new `xai_chat_state::RequestComponents` estimates one request's composition by walking its items and tool specs:

| Bucket | Source |
|---|---|
| `system_tokens` | `System` items, including the primary system prompt |
| `tool_schema_tokens` | the serialized `tools` specs on the request |
| `user_tokens` | text of user items with `SyntheticReason::Human` |
| `injected_tokens` | text of runtime-injected user items (reminders, project instructions, auto-continue, interjections) |
| `compaction_meta_tokens` | text of `SyntheticReason::CompactionMeta` items: the compact summary and re-read file contents |
| `image_tokens` | image parts on user items **and** on tool results |
| `assistant_tokens` | assistant text plus tool-call arguments |
| `reasoning_tokens` | replayed reasoning |
| `tool_result_tokens` | tool results, including backend-hosted calls |

Classification is by item type and `SyntheticReason`, never by parsing message text. That is what makes the compact summary separable at all: the compaction pipeline tags its injected items `CompactionMeta`, which is distinct from `SystemReminder`, `ProjectInstructions`, and the rest.

Three decisions worth stating:

- **Estimates, not provider counts.** These use the same bytes/4 arithmetic the context-budget code already uses. `total_tokens` is the sum of the buckets and covers items plus declared tool specs; hosted tools and provider-side framing are not estimated, so it is a composition estimate, not a bill.
- **Component sums pair with billed input.** Every completed main-loop call folds its request's composition, so the sums cover the same calls `totals.input_tokens` covers and a bucket's share is comparable to the billed input. Because a prefix repeats across calls, both sides grow the same way; a share, not an absolute, is the readable number.
- **Recorded with the response, not at request build.** Components are folded inside `record_response_token_usage`, so a call that completes with no reported usage still contributes its composition — the composition is known even when the cost is not. A request that never completes contributes nothing, matching the rule everywhere else in this experiment.

`image_tokens` is deliberately wider than the shared budget estimator: it also counts images inline in tool results, which the budget estimate ignores but the provider still bills.

The persisted session report gains a `requestComponents` block:

```json
{
  "session": {
    "inputTokens": 1204000,
    "requestComponents": {
      "requestsMeasured": 42,
      "systemTokens": 62000,
      "toolSchemaTokens": 210000,
      "userTokens": 3400,
      "injectedTokens": 51000,
      "compactionMetaTokens": 88000,
      "toolResultTokens": 742000,
      "totalTokens": 1176400
    }
  }
}
```

`requestsMeasured` matters as much as the buckets: it is the count of main-loop calls whose request was measured. If it is below the session's turn count, some calls contributed billed tokens with no measured request, and the shares describe only part of the bill. A ledger that measured no request omits the block entirely rather than reporting zeros, so "not measured" cannot be misread as "an empty prompt".

### Verification

| Check | Result |
|---|---|
| `cargo test -p xai-chat-state --lib` | 381 passed (374 before; 7 new cases) |
| `cargo test -p xai-grok-shell --lib` | 7001 passed, 5 failed — the same five failures occur on the base revision (see section 12) |
| `cargo check -p xai-grok-shell -p xai-grok-pager -p xai-grok-sampling-types` | passed |
| `rustfmt --check` on the touched files, `git diff --check` | clean |

New cases, by what they pin:

- `components_split_by_item_type_and_synthetic_reason` puts one item of every kind in a single request and asserts each bucket, with expectations written against each literal's own length so the test pins the *classification* rather than re-deriving the arithmetic.
- `every_other_synthetic_reason_lands_in_injected` and `images_are_split_out_of_their_user_item` pin the two classifications that are easy to get subtly wrong: a project-instruction item is not user text, and an image inside a user item is not user text.
- `tool_result_images_are_counted` pins the deliberate divergence from the budget estimator.
- `fold_sums_every_bucket` and `an_empty_request_is_all_zero` pin accumulation and the empty case.
- `request_components_accumulate_and_never_touch_the_turn_count` pins at the ledger that components are estimates: they touch neither `totals.input_tokens` nor `main_loop_model_calls`.
- `response_without_usage_preserves_context_and_marks_ledgers_incomplete` now also asserts that a no-usage call still contributes its composition.
- `session_report_shows_the_request_composition` and `session_report_omits_request_composition_when_unmeasured` pin the report shape, the `requestComponents` key, the round trip, and the omitted-when-unmeasured rule.

### What this does not establish

- **The shell-side wiring is not covered by a turn-level test.** That `turn.rs` estimates the request *after* the image strip and token clamp (so the breakdown describes what is actually sent) and passes it into the recording call is verified by reading and by compilation. Everything downstream — the classifier, the ledger fold, the report — is tested. A turn-level test would need a full session plus a model server, the harness shape that made the suite unstable in section 12.
- Nothing here says whether the pruning arm actually reduces the tool-result share. Measuring that is Step 3, and it is now measurable: the block reports the share per session.
- The buckets are estimates in bytes/4 units. They will not sum to the provider's billed input, and the gap is not attributed anywhere.
- Hosted tools are not estimated, so on a backend-searching turn the breakdown under-counts the request.
- Components are recorded for main-loop calls only. Compaction, recap, memory, and the other side calls fold usage but not composition, so the block does not explain their prompts.
- Component sums live on the session ledger only, not the per-prompt ledger the ACP wire reports.
