# Real-model suite: run order after a code update

Operator note for the next person who changes product code and needs a green `scripts/real-model-suite` score. Spec: [`real-model-feature-suite.md`](./real-model-feature-suite.md). Short README: [`../scripts/real-model-suite/README.md`](../scripts/real-model-suite/README.md).

## Why order matters

1. **Unit tests first** — fail cheap and local; do not burn a model on a regression `cargo test` already catches.
2. **Rebuild the pager** — `run.sh` executes `target/debug/xai-grok-pager`, not `~/.local/bin/cook`. `cargo test` does **not** rebuild that binary.
3. **Quiet tree, one model** — `runner.isolated` fails if `git status --porcelain` or `~/.cook/config.toml` mtime changes during the phase. Another agent editing files mid-run pollutes the score. Launchers share port `8080`; only one model at a time.
4. **Full phase, then re-score** — each `--case` overwrites `$OUT_ROOT/score.txt`. A clean score needs one full selected phase (or a merged evidence set you control).
5. **Do not raise turn caps / rewrite prompts** to force a pass. Fix the product (or a scorer phrase gap if the oracle was wrong) and re-run.

## Order (copy-paste)

```bash
# 0) Set launcher (one of; default is mimo26-9b)
export MODEL=spark25-4b          # wire spark25, config local/spark25
# export MODEL=mimo26-9b         # default
# export MODEL=bonsai2-27b       # wire bonsai2
# Do not run two of these on :8080 at once.

# 1) Targeted unit tests for the crates you touched
cargo test -p xai-grok-memory --lib
cargo test -p xai-grok-tools --lib
cargo test -p xai-grok-agent --lib
# plus any other -p you edited

# 2) Scorer self-test + pager build (both required before a real phase)
python3 scripts/real-model-suite/score.py --self-test
cargo build -p xai-grok-pager-bin --bin xai-grok-pager

# 3) Quiet tree check — no mid-phase dirtying
git status --porcelain
# Optional: wait until other agents' cargo is idle
# ps -eo pid,comm,args | grep -E '[c]argo|[r]ustc'

# 4) List cases (no model start)
scripts/real-model-suite/run.sh --list

# 5) Full claimed phase into a FRESH OUT_ROOT, keep artifacts
OUT_ROOT=/tmp/real-model-$(date +%Y%m%d-%H%M%S)
MODEL=$MODEL OUT_ROOT="$OUT_ROOT" scripts/real-model-suite/run.sh --phase tools --keep

# 6) Read the score
cat "$OUT_ROOT/score.txt"
cat "$OUT_ROOT/failures.md"   # only fail/hung + skip sections matter
grep -E ' fail| hung' "$OUT_ROOT/score.txt" || echo 'zero fail/hung'

# 7) If cases fail: fix product (+ unit test), rebuild pager, re-run ONLY fails,
#    then re-run the FULL phase into a NEW OUT_ROOT for a clean score.txt.
# Each --case overwrites score.txt under that OUT_ROOT — do not mix.
```

Phases: `cli` | `tools` | `session` | `agents` | `all`.  
`cli` never starts the model. `all` is ~70–110 minutes on MiMo.  
`--keep` keeps a successful run’s `OUT_ROOT`; failures are always kept.

## Per failure class

| Score line | What to do |
|---|---|
| `fail` + product pillar in `failures.md` | Fix that crate’s behavior. Add a real unit test. Rebuild pager. Re-run case, then full phase. |
| `fail` + scorer phrase/oracle wrong | Fix `score.py` (or case JSON) only if the contract was wrong. Re-run `score.py --self-test`. Do not loosen a correct oracle. |
| `fail` + non-zero exit / `max turns` | Model burned the turn budget (`session.max_turns` is the planned non-zero-exit exception). Prefer product discoverability (e.g. tool responses that advertise paths) over raising caps. |
| `hung timeout` | Raise only if the case’s documented timeout was wrong; otherwise diagnose invoke/wire. |
| `runner.isolated` | Another process changed `git status` or `~/.cook/config.toml` during the phase. Stop the other editor/cargo, re-run the full phase on a quiet tree. **Isolated success writes no score line** — absence of `runner.isolated fail` plus matching before/after status is the pass. |
| `skip-nondeterministic` | Expected (e.g. `tools.unknown_and_sibling` did not emit an invalid tool). Not a fail. |

## Environment (optional)

| Variable | Default |
|---|---|
| `MODEL` | `mimo26-9b` |
| `WIRE` | derived: strip size suffix (`spark25-4b` → `spark25`) |
| `MODEL_KEY` | `local/$WIRE` |
| `OUT_ROOT` | `mktemp -d` (pass `--keep` and a path you control) |
| `COOK_BIN` | `<repo>/target/debug/xai-grok-pager` |

Never commit `OUT_ROOT`, wire logs, or suite `config.toml` files that contain an `api_key`. Never print the API key.

## Minimal green checklist

- [ ] Unit tests for touched crates exit 0
- [ ] `score.py --self-test` exit 0
- [ ] `cargo build -p xai-grok-pager-bin --bin xai-grok-pager` succeeds
- [ ] One model on `:8080` matching `MODEL`
- [ ] Tree quiet for the whole phase (no concurrent edits)
- [ ] Full selected phase → `score.txt` with **zero** ` fail` / ` hung`
- [ ] Evidence (`score.txt`, `failures.md`, suite log, unit/self-test logs) saved under your scratch dir

## Related docs

- Spec / case oracles: `docs/real-model-feature-suite.md`
- Suite README: `scripts/real-model-suite/README.md`
- Model launcher: `/home/thanh/models/model.sh start <launcher>` (e.g. `spark25-4b`)
