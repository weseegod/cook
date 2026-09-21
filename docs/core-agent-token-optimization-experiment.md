# Core agent token-optimization experiment: implementation and reproduction guide

Date: **2026-09-21**

Branch: `experiment/core-agent-token-optimization`

Base revision: `a8b1874dd099802bdae334733d2828a5697b05cf`

Companion design: [core-agent-flow-and-token-optimization.md](core-agent-flow-and-token-optimization.md)

## 1. Outcome

This experiment implemented two bounded changes:

1. A P0 accounting correction: a successful model response that omits usage now marks both the open prompt ledger and the session ledger incomplete. Unknown usage is no longer silently indistinguishable from a free call.
2. An opt-in P1 context arm: request-copy pruning can age tool results by tool round within one user turn and cap the recent raw-result characters. The legacy behavior remains the default because both new limits default to zero.

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
