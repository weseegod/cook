# Real-model suite: run order after a code update

Operator note for the next person who changes product code and needs a green `scripts/real-model-suite` score. Spec: [`real-model-feature-suite.md`](./real-model-feature-suite.md). Short README: [`../scripts/real-model-suite/README.md`](../scripts/real-model-suite/README.md). Latest core-agent audit: [`audits/2026-09-24-core-agent-flow-and-safeguards.md`](./audits/2026-09-24-core-agent-flow-and-safeguards.md).

## Why order matters

1. **Unit tests first** — fail cheap and local; do not burn a model on a regression `cargo test` already catches.
2. **Rebuild the pager** — `run.sh` executes `target/debug/xai-grok-pager`, not `~/.local/bin/cook`. `cargo test` does **not** rebuild that binary. After `templates/prompt.md` edits, also run `python3 crates/codegen/xai-grok-agent/scripts/encrypt_templates.py` and keep `test_encrypted_templates_not_stale` green.
3. **Quiet tree, one model** — `runner.isolated` fails if `git status --porcelain` or `~/.cook/config.toml` mtime changes during the phase. Another agent editing files mid-run pollutes the score. Launchers share port `8080`; only one model at a time.
4. **Full phase, then re-score** — each `--case` overwrites `$OUT_ROOT/score.txt`. A clean score needs one full selected phase (or a merged evidence set you control). Fix a fail with a product unit test, re-run **only that case**, then re-run the **full phase** into a **new** `OUT_ROOT`.
5. **Do not raise turn caps / rewrite case prompts** to force a pass. Fix the product (or a scorer phrase gap if the oracle was wrong) and re-run. Completion budget (`MAX_COMPLETION_TOKENS`) is not a turn cap; the suite default is `8192` so local reasoning models can finish a response.

### Harness contracts (do not re-loosen)

- Empty top-level text with `stopReason != end_turn`: rewrite home to `max_completion_tokens=8192` and **re-run the same case once**. No second prompt (“Reply with the answer… Do not call any tool.”). Stationarity-style cases set `"no_empty_retry": true` and keep the first stop.
- Non-zero exit is `fail`, except timeouts already scored as `hung` and `session.max_turns` (scored from `stopReason`).
- `skip-nondeterministic` is not a fail.
- `all` includes every phase (including `safeguard`). `cli` never starts the model.

## Full real test (follow this next time)

Defaults are `MODEL=spark25-4b` and `PARALLEL=4`. Use the saved scripts; do not retype the checklist.

```bash
# 0) Quiet tree, one model launcher, no second suite PID.
git status --porcelain
pgrep -af 'real-model-suite|xai-grok-pager' || true

# 1) Unit tests for crates you touched (expand when the diff is wider)
cargo test -p xai-grok-memory --lib
cargo test -p xai-grok-tools --lib
cargo test -p xai-grok-agent --lib
cargo test -p xai-grok-shell --lib
cargo test -p xai-grok-pager-bin --bin xai-grok-pager

# 2) Score oracle + rebuild pager (run-phase.sh does both unless SKIP_BUILD=1)
python3 scripts/real-model-suite/score.py --self-test
cargo build -p xai-grok-pager-bin --bin xai-grok-pager

# 3) Full phases into fresh OUT_ROOTs (each script prints score + failures)
#    Order: cli (no model) → tools → session → agents → safeguard
scripts/real-model-suite/run-phase.sh cli
scripts/real-model-suite/run-phase.sh tools
scripts/real-model-suite/run-phase.sh session
scripts/real-model-suite/run-phase.sh agents
scripts/real-model-suite/run-phase.sh safeguard

# 4) Core-agent audit shortcut (safeguard then session on one model)
scripts/real-model-suite/run-audit.sh

# 5) Full matrix after the individual phases are clean (long)
scripts/real-model-suite/run-phase.sh all
```

Other launchers (one at a time on `:8080`):

```bash
MODEL=mimo26-9b scripts/real-model-suite/run-phase.sh tools
MODEL=bonsai2-27b scripts/real-model-suite/run-phase.sh tools
```

`run-phase.sh` runs `score.py --self-test`, optionally `cargo build -p xai-grok-pager-bin --bin xai-grok-pager`, prints `git status --porcelain`, then `run.sh --phase <phase> --keep` and cats `score.txt` / `failures.md`. It prints the score even when the phase exits nonzero. `run-audit.sh` always runs **both** `safeguard` and `session`. Pass `SKIP_BUILD=1` when the pager is current. Extra args after the phase go to `run.sh` (e.g. `--case tools.read_file`).

Phases: `cli` | `tools` | `session` | `agents` | `safeguard` | `all`.  
`cli` never starts the model. `all` is roughly 70–110 minutes without parallelism; with `PARALLEL=4` model cases run four at a time (score lines are flock-appended).  
Each `--case` overwrites `$OUT_ROOT/score.txt`; a clean score needs one full selected phase into a fresh `OUT_ROOT`.

## Per failure class

| Score line | What to do |
|---|---|
| `fail` + product pillar in `failures.md` | Fix that crate’s behavior. Add a real unit test. Rebuild pager. Re-run case, then full phase. |
| `fail` + scorer phrase/oracle wrong | Fix `score.py` (or case JSON) only if the contract was wrong. Re-run `score.py --self-test`. Do not loosen a correct oracle. |
| `fail` + non-zero exit / `max turns` | Model burned the turn budget (`session.max_turns` is the planned non-zero-exit exception). Prefer product discoverability (e.g. tool responses that advertise paths) over raising caps. |
| `fail exit 1` + `max_tokens_truncation` | Completion budget exhausted before tools/stationarity. See audit finding `max_tokens_hard_stop`. Do not raise `max_turns`. |
| `hung timeout` | Raise only if the case’s documented timeout was wrong; otherwise diagnose invoke/wire. |
| `runner.isolated` | Another process changed `git status` or `~/.cook/config.toml` during the phase. Stop the other editor/cargo, re-run the full phase on a quiet tree. **Isolated success writes no score line** — absence of `runner.isolated fail` plus matching before/after status is the pass. |
| `skip-nondeterministic` | Expected (e.g. `tools.unknown_and_sibling` did not emit an invalid tool). Not a fail. |

## Environment (optional)

| Variable | Default |
|---|---|
| `MODEL` | `spark25-4b` |
| `PARALLEL` | `4` (concurrent model cases) |
| `WIRE` | derived: strip size suffix (`spark25-4b` → `spark25`) |
| `MODEL_KEY` | `local/$WIRE` |
| `OUT_ROOT` | `mktemp -d` (pass `--keep` and a path you control) |
| `COOK_BIN` | `<repo>/target/debug/xai-grok-pager` |
| `MAX_COMPLETION_TOKENS` | `8192` (not a turn cap; empty-text retry floor is also 8192) |
| `SKIP_BUILD` | unset (set `1` to skip `cargo build` in `run-phase.sh`) |

Never commit `OUT_ROOT`, wire logs, or suite `config.toml` files that contain an `api_key`. Never print the API key.

## Minimal green checklist

- [ ] Unit tests for touched crates exit 0
- [ ] `score.py --self-test` exit 0
- [ ] `cargo build -p xai-grok-pager-bin --bin xai-grok-pager` succeeds
- [ ] One model on `:8080` matching `MODEL`
- [ ] Tree quiet for the whole phase (no concurrent edits)
- [ ] Full selected phase → `score.txt` with **zero** ` fail` / ` hung`
- [ ] Evidence (`score.txt`, `failures.md`, suite log, unit/self-test logs) saved under your scratch dir
- [ ] For a core-agent audit: both `safeguard` and `session` green (or failures filed in `docs/audits/`)

## Latest core-agent audit (2026-09-24, `spark25-4b`)

Evidence: `/tmp/real-model-safeguard-20260924T100456Z` and `/tmp/real-model-session-20260924T101101Z` (post-fix). Pre-fix: `/tmp/real-model-safeguard-20260924T083113Z` and `/tmp/real-model-session-20260924T083459Z`. Full report: [`audits/2026-09-24-core-agent-flow-and-safeguards.md`](./audits/2026-09-24-core-agent-flow-and-safeguards.md).

| Phase | Result |
|---|---|
| safeguard | 5 pass / 2 fail (`identical_reread`, `offset_walk`) |
| session | 12 pass / 0 fail |

| Result | Cases |
|---|---|
| pass | `safeguard.bash_bound`, `safeguard.dangerous_rm`, `safeguard.large_read`, `safeguard.terminal_fanout`, `safeguard.pin_failure` |
| fail | `safeguard.identical_reread` (`tool_called: no successful read_file`, exit 0, `stopReason=max_tokens`); `safeguard.offset_walk` (`measured-nothing`, 3 reads then `max_tokens`) |

`max_tokens_hard_stop` and `large_read_silent_cap` are fixed in tree (LengthSalvage on top-level max-tokens; line-cap continuation marker). Residual fails are oracle/model measurement, not Internal error. Next: re-run those two cases; do not loosen oracles or raise `MAX_COMPLETION_TOKENS`.

## Latest tools phase (2026-09-24, `mimo26-9b`)

Evidence: `/tmp/real-model-suite-tools-20260924T051322Z` (`--phase tools --keep`).

| Result | Cases |
|---|---|
| pass (19) | `sampler.noop`, `sampler.xml_arguments`, `tools.ask_user_headless` (`ask_user_question=success`), `tools.bash`, `tools.feedback_noop`, `tools.grep`, `tools.list_dir`, `tools.lsp_smoke`, `tools.memory_roundtrip`, `tools.parallel_reads`, `tools.plan_mode`, `tools.read_file`, `tools.read_file_range`, `tools.serial_edit_read`, `tools.todo_write`, `tools.update_goal`, `tools.web_fetch_public`, `tools.web_fetch_ssrf`, `tools.write_new` |
| fail (4) | `tools.kill_and_wait` (no successful wait/output tool), `tools.monitor_short` (no successful `monitor`), `tools.scheduler_roundtrip` (`exit 1`), `tools.search_replace` (no successful `search_replace`) |
| skip | `tools.unknown_and_sibling` (`skip-nondeterministic`) |

Not green yet. Those four fails have each passed on earlier single-case retries with the same pillars; treat them as model flakes until a **full** tools `score.txt` has zero `fail`/`hung`. Do not loosen oracles. Next: fix or re-stabilize those four, full tools again, then `session` → `agents` → `safeguard` → `--phase all`. Spec handoff: `docs/real-model-feature-suite.md` §15.

## Related docs

- Spec / case oracles: `docs/real-model-feature-suite.md`
- Core-agent audit: `docs/audits/2026-09-24-core-agent-flow-and-safeguards.md`
- Suite README: `scripts/real-model-suite/README.md`
- Model launcher: `/home/thanh/models/model.sh start <launcher>` (e.g. `spark25-4b`)
